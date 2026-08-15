/**
 * ZinkMovies Scraper — 100% Pure Node.js (NO Playwright, NO Browser)
 * ====================================================================
 * Bypasses Cloudflare by using the gemma416okl.com player API directly,
 * which is NOT behind Cloudflare.
 *
 * ARCHITECTURE:
 *   1. TMDB API for metadata (get IMDB ID from TMDB ID)
 *   2. GET https://gemma416okl.com/play/{imdb_id} -> player config
 *   3. POST https://rasta428jem.com/playlist/{token}.txt -> sources JSON
 *   4. POST https://rasta428jem.com/playlist/{source}.txt -> stream URL
 *   5. Fetch HLS master playlist -> 360p/480p/720p/1080p variants
 *
 * STREAM HEADERS (REQUIRED):
 *   The stream URLs require: Referer: https://i-arch-400.keymi417exx.com/
 *   Without this header, the CDN returns 404.
 *   Each stream object includes a `headers` field.
 *
 * USAGE:
 *   node zinkmovies.js movie 155           # By TMDB ID
 *   node zinkmovies.js movie tt0468569     # By IMDB ID
 */

'use strict';

const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const TMDB_API = 'https://api.themoviedb.org/3';
const GEMMA_PLAY = 'https://gemma416okl.com/play';
const RASTA_BASE = 'https://rasta428jem.com';
const STREAM_REFERER = 'https://i-arch-400.keymi417exx.com/';
const STREAM_ORIGIN = 'https://i-arch-400.keymi417exx.com';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Proxy support: rasta428jem.com aggressively rate-limits cloud IPs (Render, etc.),
// returning "7" for every request. When ALL_PROXY is set, we route requests
// through the proxy to bypass the IP-based rate limit.
// Supports http://, https://, socks5://, socks5h:// proxy URLs via undici ProxyAgent.
let _proxyDispatcher = null;
let _proxyInitTried = false;
function getProxyDispatcher() {
  if (_proxyInitTried) return _proxyDispatcher;
  _proxyInitTried = true;
  const proxyUrl = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxyUrl) return null;
  try {
    const { ProxyAgent } = require('undici');
    _proxyDispatcher = new ProxyAgent(proxyUrl);
    console.log(`[zinkmovies] using proxy: ${proxyUrl.replace(/:[^:@]+@/, ':***@')}`);
  } catch (e) {
    console.error(`[zinkmovies] proxy init failed: ${e.message}`);
  }
  return _proxyDispatcher;
}

/** Fetch with timeout and UA. */
async function fetchUrl(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const fetchOpts = {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers,
      },
    };
    // Use proxy dispatcher if available (bypasses IP rate limits on rasta428jem.com)
    const dispatcher = getProxyDispatcher();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;

    const r = await fetch(url, fetchOpts);
    return {
      status: r.status,
      headers: Object.fromEntries(r.headers.entries()),
      body: await r.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

class ZinkMoviesScraper {
  constructor(timeout = 15000) {
    this.timeout = timeout;
  }

  async _getImdbId(tmdbId, type = 'movie') {
    if (String(tmdbId).startsWith('tt')) return tmdbId;
    const r = await fetchUrl(
      `${TMDB_API}/${type}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );
    return JSON.parse(r.body).imdb_id;
  }

  async getInfo(tmdbId, type = 'movie') {
    const r = await fetchUrl(
      `${TMDB_API}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
    );
    return JSON.parse(r.body);
  }

  _extractConfig(html) {
    let m = html.match(/let p3 = (\{[\s\S]*?\})\s*;/);
    if (m) { try { return JSON.parse(m[1].replace(/\\\//g, '/')); } catch {} }
    m = html.match(/new HDVBPlayer\((\{[\s\S]*?\})\)/);
    if (m) { try { return JSON.parse(m[1].replace(/\\\//g, '/')); } catch {} }
    return null;
  }

  /**
   * Get all HLS streams for a movie.
   * @returns {Promise<Array>} Stream objects with {name, title, url, quality, headers, source}
   */
  async getMovieStreams(tmdbOrImdbId, title = '') {
    const imdbId = await this._getImdbId(tmdbOrImdbId, 'movie');
    const rawStreams = await this._getGemmaStreams(imdbId);

    // Get display title
    let displayTitle = title;
    if (!displayTitle) {
      try {
        if (!String(tmdbOrImdbId).startsWith('tt')) {
          const info = await this.getInfo(tmdbOrImdbId, 'movie');
          displayTitle = info.title || imdbId;
        } else {
          displayTitle = imdbId;
        }
      } catch {
        displayTitle = imdbId;
      }
    }

    // Parse each stream's master playlist to get quality variants
    const result = [];
    for (const s of rawStreams) {
      try {
        const variants = await this._parseMasterPlaylist(s.url, s.title, displayTitle);
        result.push(...variants);
      } catch {
        result.push({
          name: `ZinkMovies | ${s.title}`,
          title: displayTitle,
          url: s.url,
          quality: 'HLS',
          source: 'zinkmovies',
          headers: { 'Referer': STREAM_REFERER, 'Origin': STREAM_ORIGIN },
        });
      }
    }

    // Sort by bandwidth (highest quality first)
    result.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return result;
  }

  /**
   * Get all HLS streams for a series episode.
   * Uses the show's IMDB ID — gemma416okl.com resolves it to the show's streams.
   */
  async getSeriesStreams(tmdbId, season, episode, title = '') {
    const imdbId = await this._getImdbId(tmdbId, 'tv');
    const rawStreams = await this._getGemmaStreams(imdbId);

    let displayTitle = title;
    if (!displayTitle) {
      try {
        const info = await this.getInfo(tmdbId, 'tv');
        const name = info.name || imdbId;
        displayTitle = `${name} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      } catch {
        displayTitle = `${imdbId} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      }
    }

    const result = [];
    for (const s of rawStreams) {
      try {
        const variants = await this._parseMasterPlaylist(s.url, s.title, displayTitle);
        result.push(...variants);
      } catch {
        result.push({
          name: `ZinkMovies | ${s.title}`,
          title: displayTitle,
          url: s.url,
          quality: 'HLS',
          source: 'zinkmovies',
          headers: { 'Referer': STREAM_REFERER, 'Origin': STREAM_ORIGIN },
        });
      }
    }

    result.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return result;
  }

  /**
   * Core: Get gemma stream URLs.
   * Retries up to 4 times with backoff when rate-limited (server returns "7").
   *
   * Retry schedule [0, 2, 5, 10] = 17s total, fits within the 30s source timeout
   * with ~13s buffer for actual HTTP requests. The original [0, 2, 5, 15, 30] = 52s
   * schedule would exceed the source timeout and cause the source to be killed.
   */
  async _getGemmaStreams(imdbId) {
    const delays = [0, 2000, 5000, 10000];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        console.error(`[ZinkMovies] Retrying in ${delays[attempt]/1000}s (attempt ${attempt+1}/${delays.length})...`);
        await sleep(delays[attempt]);
      }

      try {
        // Step 1: Get player config
        const r1 = await fetchUrl(`${GEMMA_PLAY}/${imdbId}`, {
          headers: { Referer: 'https://new3.zinkmovies.today/' },
        });
        const config = this._extractConfig(r1.body);
        if (!config || !config.file || !config.key) {
          throw new Error('No config found');
        }

        let fileUrl = config.file;
        if (!fileUrl.startsWith('http')) {
          fileUrl = RASTA_BASE + fileUrl;
        }

        // Step 2: POST to get sources
        const r2 = await fetchUrl(fileUrl, {
          method: 'POST',
          headers: {
            'X-CSRF-TOKEN': config.key,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://gemma416okl.com',
            'Referer': `${GEMMA_PLAY}/${imdbId}`,
          },
        });

        if (r2.body === '7' || !r2.body.startsWith('[')) {
          throw new Error('Rate limited or server error');
        }

        const sources = JSON.parse(r2.body);
        const baseUrl = fileUrl.substring(0, fileUrl.lastIndexOf('/') + 1);

        // Step 3: Get stream URLs SEQUENTIALLY (parallel requests cause token expiry)
        const validStreams = [];
        for (const src of sources) {
          if (!src.file || !src.file.startsWith('~')) continue;
          try {
            const streamFileUrl = baseUrl + src.file.substring(1) + '.txt';
            const r3 = await fetchUrl(streamFileUrl, {
              method: 'POST',
              headers: {
                'X-CSRF-TOKEN': config.key,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://gemma416okl.com',
                'Referer': `${GEMMA_PLAY}/${imdbId}`,
              },
            });
            const url = r3.body.trim();
            if (url.startsWith('http')) {
              validStreams.push({ title: src.title, url });
            }
          } catch {}
        }

        if (validStreams.length > 0) return validStreams;
        throw new Error('No valid streams');
      } catch (e) {
        if (attempt === delays.length - 1) {
          throw new Error(`Failed after ${delays.length} attempts: ${e.message}`);
        }
      }
    }
  }

  /**
   * Parse HLS master playlist into quality variants.
   */
  async _parseMasterPlaylist(masterUrl, label, displayTitle) {
    const r = await fetchUrl(masterUrl, {
      headers: { Referer: STREAM_REFERER, Origin: STREAM_ORIGIN },
    });
    if (!r.body.includes('#EXTM3U')) {
      throw new Error('Not an HLS playlist');
    }

    const lines = r.body.split('\n').map(l => l.trim()).filter(Boolean);
    const streams = [];
    let currentInf = {};

    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
        const bwMatch = attrs.match(/BANDWIDTH=(\d+)/);
        const resMatch = attrs.match(/RESOLUTION=([^,]+)/);
        currentInf = {
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
          resolution: resMatch ? resMatch[1] : '',
        };
      } else if (line.startsWith('http') || line.startsWith('./') || line.startsWith('../')) {
        if (currentInf.bandwidth) {
          let url = line;
          if (url.startsWith('./') || url.startsWith('../')) {
            const base = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
            url = new URL(url, base).href;
          }
          const h = currentInf.resolution
            ? parseInt(currentInf.resolution.split('x')[1])
            : 0;
          let quality = 'unknown';
          if (h >= 1080) quality = '1080p';
          else if (h >= 720) quality = '720p';
          else if (h >= 480) quality = '480p';
          else if (h >= 350) quality = '360p';

          streams.push({
            name: `ZinkMovies | ${label} | ${quality}`,
            title: displayTitle || label,
            quality,
            resolution: currentInf.resolution,
            bandwidth: currentInf.bandwidth,
            url,
            source: 'zinkmovies',
            headers: { 'Referer': STREAM_REFERER, 'Origin': STREAM_ORIGIN },
          });
          currentInf = {};
        }
      }
    }

    if (streams.length === 0) {
      streams.push({
        name: `ZinkMovies | ${label}`,
        title: displayTitle || label,
        quality: 'HLS',
        url: masterUrl,
        source: 'zinkmovies',
        headers: { 'Referer': STREAM_REFERER, 'Origin': STREAM_ORIGIN },
      });
    }

    return streams;
  }
}

// CLI
if (require.main === module) (async () => {
  const s = new ZinkMoviesScraper();
  const args = process.argv.slice(2);
  const mediaType = args[0] || 'movie';
  const id = args[1] || 'tt0468569';

  console.log('=== ZinkMovies Scraper (Pure Node.js) ===');
  console.log(`Loading: ${mediaType} ${id}\n`);

  try {
    if (!String(id).startsWith('tt') && mediaType === 'movie') {
      const info = await s.getInfo(id, 'movie');
      console.log(`Title: ${info.title} (${info.release_date?.slice(0,4) || '?'})`);
      console.log(`IMDb: ${info.imdb_id || 'N/A'}\n`);
    }
  } catch {}

  try {
    if (mediaType === 'movie') {
      const streams = await s.getMovieStreams(id);
      console.log(`Got ${streams.length} streams:\n`);
      for (const st of streams) {
        console.log(`  [${st.quality}] ${st.name}`);
        console.log(`    URL: ${st.url}`);
        console.log(`    Headers: ${JSON.stringify(st.headers)}`);
        console.log();
      }

      // Verify first stream
      if (streams.length > 0) {
        console.log('--- Verifying first stream ---');
        const r = await fetchUrl(streams[0].url, { headers: streams[0].headers });
        console.log('Status:', r.status);
        console.log('Is HLS:', r.body.includes('#EXTM3U'));
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
  }
})();

module.exports = { ZinkMoviesScraper };
