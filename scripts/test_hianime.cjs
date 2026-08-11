/**
 * HiAnime Scraper — 100% Pure Node.js (NO Playwright)
 * =====================================================
 * hianime.at — Watch anime with Sub and Dub in HD
 *
 * Full flow (all pure HTTP, no browser):
 *   1. Search: GET /search?keyword={query} → anime slug+ID
 *   2. Episodes: GET /api/theme/episode/list/{animeId} → episode IDs
 *   3. Servers: GET /api/theme/episode/servers?episodeId={id} → sub+sub server list (base64 hashes)
 *   4. Stream page: GET {decoded hash URL} → extract window.__P
 *   5. Deobfuscate: base64decode → XOR("otaku-embed-v1") → JSON → {src: m3u8, subtitles: [...]}
 *   6. Play m3u8 with Referer: https://zokoanime.video/
 *
 * Supports: SUB + DUB, multiple servers (HD-1, HD-2), VTT subtitles
 *
 * Install: npm install axios cheerio
 * Usage:   node hianime_scraper.js "jujutsu kaisen" 1 sub
 *          node hianime_scraper.js "jujutsu kaisen" 1 dub
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const BASE = 'https://hianime.at';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OBF_KEY = 'otaku-embed-v1';

class HiAnimeScraper {
  constructor() {
    this.client = axios.create({
      timeout: 15000,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      maxRedirects: 5,
    });
  }

  /** Search for anime by title. Returns [{title, url, id, slug}]. */
  async search(query) {
    const r = await this.client.get(`${BASE}/search?keyword=${encodeURIComponent(query)}`);
    const $ = cheerio.load(r.data);
    const results = [];
    const seen = new Set();
    // Try .film-name a first
    $('.film-name a').each((_, el) => {
      const link = $(el).attr('href') || '';
      const title = $(el).text().trim();
      const m = link.match(/\/([^/]+)-(\d+)$/);
      if (m && !seen.has(m[2])) {
        seen.add(m[2]);
        results.push({ title, url: link, id: parseInt(m[2]), slug: m[1] });
      }
    });
    // Fallback: scan all <a> tags for /watch/{slug}-{id} pattern
    if (!results.length) {
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/watch\/([^/]+)-(\d+)$/);
        if (m && !seen.has(m[2])) {
          seen.add(m[2]);
          results.push({ title: $(el).text().trim() || m[1].replace(/-/g, ' '), url: href, id: parseInt(m[2]), slug: m[1] });
        }
      });
    }
    return results;
  }

  /** Get episode list for an anime. Returns [{id, number}]. */
  async getEpisodes(animeId) {
    const r = await this.client.get(`${BASE}/api/theme/episode/list/${animeId}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/watch/` },
    });
    const html = r.data.html || '';
    const $ = cheerio.load(html);
    const episodes = [];
    $('.ssl-item').each((_, el) => {
      const id = $(el).attr('data-id');
      const num = $(el).attr('data-number');
      if (id) episodes.push({ id: parseInt(id), number: parseInt(num || '0') });
    });
    // Fallback: regex parse
    if (!episodes.length) {
      const matches = [...html.matchAll(/data-number="(\d+)"[^>]*data-id="(\d+)"/g)];
      for (const m of matches) {
        episodes.push({ id: parseInt(m[2]), number: parseInt(m[1]) });
      }
    }
    return episodes.sort((a, b) => a.number - b.number);
  }

  /** Get available servers for an episode. Returns [{type, name, url}]. */
  async getServers(episodeId) {
    const r = await this.client.get(`${BASE}/api/theme/episode/servers`, {
      params: { episodeId },
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/watch/` },
    });
    const html = r.data.html || '';
    const $ = cheerio.load(html);
    const servers = [];
    $('.server-item').each((_, el) => {
      const type = $(el).attr('data-type') || 'sub';
      const name = $(el).attr('data-server-name') || 'unknown';
      const hash = $(el).attr('data-hash') || '';
      let url = '';
      try { url = Buffer.from(hash, 'base64').toString('utf-8'); } catch (e) {}
      if (url) servers.push({ type, name, url });
    });
    return servers;
  }

  /**
   * Deobfuscate the stream data from the player page.
   * Algorithm: base64decode → XOR with "otaku-embed-v1" → JSON parse
   */
  deobfuscate(p) {
    // Pad base64
    const padded = p + '='.repeat((4 - (p.length % 4)) % 4);
    const raw = Buffer.from(padded, 'base64');
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
      out[i] = raw[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
    }
    return JSON.parse(out.toString('utf-8'));
  }

  /**
   * Get stream URL + subtitles from a server URL.
   * Fetches the stream page, extracts window.__P, deobfuscates it.
   */
  async getStream(serverUrl) {
    const r = await this.client.get(serverUrl, {
      headers: { Referer: `${BASE}/` },
    });
    const m = r.data.match(/window\.__P="([^"]+)"/);
    if (!m) throw new Error('No __P found in stream page');

    const data = this.deobfuscate(m[1]);
    return {
      src: data.src,
      subtitles: data.subtitles || [],
      downloadUrl: data.download_url || null,
      thumbnail: data.thumbnail || null,
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

    // 2. Get episodes
    const episodes = await this.getEpisodes(anime.id);
    const ep = episodes.find(e => e.number === episode);
    if (!ep) return [];

    // 3. Get servers
    const servers = await this.getServers(ep.id);
    const filtered = servers.filter(s => s.type === category);
    if (!filtered.length) return [];

    // 4. Get stream from each server
    const streams = [];
    for (const server of filtered) {
      try {
        const stream = await this.getStream(server.url);

        // Determine referer from server URL
        const refererHost = new URL(server.url).origin + '/';

        // Parse quality from m3u8 URL or server name
        const quality = server.name.includes('HD') ? '1080p' : '720p';

        streams.push({
          name: `HiAnime\n${server.name} ${category.toUpperCase()}`,
          title: `${anime.title} - Episode ${episode} (${category.toUpperCase()})`,
          url: stream.src,
          quality,
          behaviorHints: {
            notWebReady: true,
            headers: { Referer: refererHost },
          },
          meta: {
            provider: 'HiAnime',
            source: server.name,
            server: new URL(server.url).hostname,
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
            animeTitle: anime.title,
            animeId: anime.id,
            episode: episode,
            episodeId: ep.id,
            category: category,
            downloadUrl: stream.downloadUrl,
          },
        });
      } catch (e) {
        // Skip failed servers
      }
    }

    return streams;
  }
}

// CLI
if (require.main === module) (async () => {
  const s = new HiAnimeScraper();
  const query = process.argv[2] || 'jujutsu kaisen';
  const episode = parseInt(process.argv[3]) || 1;
  const category = process.argv[4] || 'sub';

  console.log(`HiAnime — "${query}" episode ${episode} (${category})`);
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
    for (const st of streams.slice(0, 2)) {
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

module.exports = { HiAnimeScraper };
