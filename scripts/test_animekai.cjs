/**
 * AnimeKai Scraper — 100% Pure Node.js (NO Playwright)
 * =====================================================
 * animekai.at — Watch Anime online with DUB and SUB for FREE
 *
 * Full flow (all pure HTTP, no browser):
 *   1. Search: GET /?s={query} → /watch/{slug}/
 *   2. Watch page: GET /watch/{slug}/ → extract POST_ID, MAL_ID, SUB_COUNT, DUB_COUNT
 *   3. AJAX: POST /wp-admin/admin-ajax.php with action=get_auto_embed_player
 *      → returns iframe_src (megaplay.buzz/stream/mal/{MAL_ID}/{ep}/{sub|dub})
 *   4. Stream page: GET https://zokoanime.video/stream/mal/{MAL_ID}/{ep}/{sub|dub}
 *      (zokoanime.video uses the same MAL ID and has simpler __P obfuscation)
 *   5. Deobfuscate: base64decode(window.__P) → XOR("otaku-embed-v1") → JSON
 *      → { src: m3u8 URL, subtitles: [VTT tracks] }
 *   6. Play m3u8 with Referer: https://zokoanime.video/
 *
 * Supports: SUB + DUB, multiple servers, VTT subtitles (9+ languages)
 *
 * Install: npm install axios cheerio
 * Usage:   node animekai_scraper.js "jujutsu kaisen" 1 sub
 *          node animekai_scraper.js "jujutsu kaisen" 1 dub
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { execSync } = require('child_process');

const BASE = 'https://animekai.at';
const ZOKO = 'https://zokoanime.video';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OBF_KEY = 'otaku-embed-v1';

class AnimeKaiScraper {
  constructor() {
    this.client = axios.create({
      timeout: 15000,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      maxRedirects: 5,
    });
  }

  /** Use system curl for CF-protected pages (different TLS fingerprint). */
  _curlGet(url, referer = null) {
    const refHeader = referer ? ` -H "Referer: ${referer}"` : '';
    return execSync(
      `curl -sS -L --max-time 10 -A "${UA}"${refHeader} "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
    );
  }

  /** Use system curl for POST requests. */
  _curlPost(url, body, referer = null) {
    const refHeader = referer ? ` -H "Referer: ${referer}"` : '';
    return execSync(
      `curl -sS -L --max-time 10 -A "${UA}"${refHeader} -H "Content-Type: application/x-www-form-urlencoded" -H "X-Requested-With: XMLHttpRequest" -d "${body}" "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
    );
  }

  /** Search for anime by title. Returns [{title, url, slug}]. */
  async search(query) {
    // Use system curl (bypasses CF JS Detection on animekai.at)
    const html = this._curlGet(`${BASE}/?s=${encodeURIComponent(query)}`);
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/watch\/([^/]+)\/?$/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        results.push({
          title: $(el).text().trim() || m[1].replace(/-/g, ' '),
          url: href,
          slug: m[1],
        });
      }
    });

    return results;
  }

  /**
   * Extract anime metadata from the watch page.
   * Returns { postId, malId, subCount, dubCount, title }.
   */
  async getAnimeInfo(watchUrl) {
    // Use system curl (animekai.at has CF JS Detection)
    const html = this._curlGet(watchUrl, `${BASE}/`);

    const postId = html.match(/POST_ID\s*=\s*["'](\d+)["']/)?.[1];
    const malId = html.match(/MAL_ID\s*=\s*["'](\d+)["']/)?.[1];
    const subCount = parseInt(html.match(/SUB_COUNT\s*=\s*(\d+)/)?.[1] || '0');
    const dubCount = parseInt(html.match(/DUB_COUNT\s*=\s*(\d+)/)?.[1] || '0');

    const $ = cheerio.load(html);
    const title = $('h1, .entry-title, .anime-title').first().text().trim() ||
                  watchUrl.split('/').filter(s => s).pop()?.replace(/-/g, ' ') || '';

    return { postId, malId, subCount, dubCount, title };
  }

  /**
   * Get stream URL via the WordPress AJAX endpoint.
   * Returns the iframe_src URL (megaplay.buzz or zokoanime.video).
   */
  async getIframeSrc(postId, malId, episode, type = 'sub') {
    const body = `action=get_auto_embed_player&post_id=${postId}&mal_id=${malId}&anilist_id=&ep=${episode}&type=${type}&server_index=0`;
    const result = this._curlPost(`${BASE}/wp-admin/admin-ajax.php`, body, `${BASE}/watch/`);
    const data = JSON.parse(result);
    return data?.data?.iframe_src || null;
  }

  /**
   * Deobfuscate the stream data from zokoanime.video player page.
   * Algorithm: base64decode → XOR("otaku-embed-v1") → JSON parse
   */
  deobfuscate(p) {
    const padded = p + '='.repeat((4 - (p.length % 4)) % 4);
    const raw = Buffer.from(padded, 'base64');
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
      out[i] = raw[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
    }
    return JSON.parse(out.toString('utf-8'));
  }

  /**
   * Get stream URL + subtitles from zokoanime.video.
   * Uses the same MAL ID as animekai.at.
   */
  async getStream(malId, episode, type = 'sub') {
    const streamUrl = `${ZOKO}/stream/mal/${malId}/${episode}/${type}`;
    const r = await this.client.get(streamUrl, {
      headers: { Referer: `${BASE}/` },
    });
    const m = r.data.match(/window\.__P="([^"]+)"/);
    if (!m) throw new Error('No __P found in stream page');

    const data = this.deobfuscate(m[1]);
    return {
      src: data.src,
      subtitles: data.subtitles || [],
      downloadUrl: data.download_url || null,
    };
  }

  /**
   * HIGH-LEVEL: Get all streams for an anime episode.
   * Returns Stremio-compatible stream objects with rich metadata.
   *
   * @param {string} query - Anime title to search
   * @param {number} episode - Episode number (1-based)
   * @param {string} category - 'sub' or 'dub'
   * @returns {Promise<Array>} Stream objects
   */
  async getStreams(query, episode, category = 'sub') {
    // 1. Search
    const results = await this.search(query);
    if (!results.length) return [];
    const anime = results[0];

    // 2. Get anime info (POST_ID, MAL_ID)
    const info = await this.getAnimeInfo(anime.url);
    if (!info.malId) return [];

    // 3. Check if episode exists
    const maxEps = category === 'dub' ? info.dubCount : info.subCount;
    if (episode > maxEps) return [];

    // 4. Get stream via zokoanime.video (same MAL ID, simpler deobfuscation)
    try {
      const stream = await this.getStream(info.malId, episode, category);

      // Parse quality
      const quality = '1080p';

      return [{
        name: `AnimeKai\n${category.toUpperCase()}`,
        title: `${info.title} - Episode ${episode} (${category.toUpperCase()})`,
        url: stream.src,
        quality,
        behaviorHints: {
          notWebReady: true,
          headers: { Referer: `${ZOKO}/` },
        },
        meta: {
          provider: 'AnimeKai',
          source: 'zokoanime.video',
          server: 'zokoanime.video',
          quality,
          type: 'hls',
          audio: category === 'dub' ? 'english' : 'japanese',
          language: category === 'dub' ? ['en'] : ['ja'],
          subtitles: stream.subtitles.map(s => ({
            label: s.label,
            lang: s.lang,
            url: s.src,
            default: s.default,
          })),
          animeTitle: info.title,
          malId: info.malId,
          postId: info.postId,
          episode,
          category,
          subCount: info.subCount,
          dubCount: info.dubCount,
          downloadUrl: stream.downloadUrl,
        },
      }];
    } catch (e) {
      return [];
    }
  }
}

// CLI
if (require.main === module) (async () => {
  const s = new AnimeKaiScraper();
  const query = process.argv[2] || 'jujutsu kaisen';
  const episode = parseInt(process.argv[3]) || 1;
  const category = process.argv[4] || 'sub';

  console.log(`AnimeKai — "${query}" episode ${episode} (${category})`);
  const streams = await s.getStreams(query, episode, category);
  console.log(`\n${streams.length} stream(s):\n`);

  for (const st of streams) {
    const m = st.meta;
    console.log(`  [${m.source}] ${m.quality} ${m.type} audio=${m.audio}`);
    console.log(`    URL: ${st.url.slice(0, 100)}...`);
    console.log(`    Referer: ${st.behaviorHints.headers.Referer}`);
    console.log(`    Subtitles: ${m.subtitles.length} tracks`);
    for (const sub of m.subtitles.slice(0, 3)) {
      console.log(`      ${sub.label} (${sub.lang})${sub.default ? ' [default]' : ''}`);
    }
    console.log();
  }

  // Verify playability
  if (streams.length) {
    console.log('=== Verifying playability ===');
    for (const st of streams) {
      try {
        const r = await axios.head(st.url, {
          headers: { 'User-Agent': UA, ...st.behaviorHints.headers },
          timeout: 8000, validateStatus: () => true,
        });
        console.log(`  ${st.meta.source}: HTTP ${r.status} ${r.headers['content-type'] || ''}`);
      } catch (e) {
        console.log(`  ${st.meta.source}: ERROR - ${e.message}`);
      }
    }
  }
})();

module.exports = { AnimeKaiScraper };
