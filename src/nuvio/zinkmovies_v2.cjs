/**
 * ZinkMovies Scraper — 100% Pure Node.js (NO Playwright, NO Browser)
 * ====================================================================
 * Bypasses Cloudflare by using the gemma416okl.com player API directly,
 * which is NOT behind Cloudflare. The main zinkmovies.today site has CF
 * managed challenge, but the actual streaming infrastructure doesn't.
 *
 * ARCHITECTURE:
 *   1. TMDB API for metadata (get IMDB ID from TMDB ID)
 *   2. GET https://gemma416okl.com/play/{imdb_id}
 *      -> HTML with HDVBPlayer config: {file: "/playlist/XXX.txt", key: "YYY"}
 *   3. POST https://rasta428jem.com/playlist/XXX.txt
 *      Headers: X-CSRF-TOKEN: YYY, Origin: https://gemma416okl.com
 *      -> JSON array of sources: [{title: "Hindi", file: "~ZZZ"}, ...]
 *   4. POST https://rasta428jem.com/playlist/ZZZ.txt
 *      Headers: X-CSRF-TOKEN: YYY, Origin: https://gemma416okl.com
 *      -> Stream URL: https://i-arch-400.rasta428jem.com/.../index.m3u8
 *   5. Fetch HLS master playlist -> 360p, 480p, 720p, 1080p variants
 *
 * RATE LIMITING:
 *   The rasta428jem.com API rate-limits after ~5 rapid requests.
 *   When rate-limited, it returns "7" instead of JSON.
 *   This scraper waits 60s and retries when that happens.
 *
 * USAGE:
 *   node zinkmovies.js movie 155                    # The Dark Knight (TMDB ID)
 *   node zinkmovies.js movie tt0468569              # By IMDB ID directly
 */

'use strict';

const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const TMDB_API = 'https://api.themoviedb.org/3';
const GEMMA_PLAY = 'https://gemma416okl.com/play';
const RASTA_BASE = 'https://rasta428jem.com';
const STREAM_ORIGIN = 'https://i-arch-400.keymi417exx.com';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Proxy support: rasta428jem.com aggressively rate-limits cloud IPs (Render, etc.),
// returning "7" for every request. When ALL_PROXY is set, we route requests
// through the proxy to bypass the IP-based rate limit.
// Supports http://, https://, socks5://, socks5h:// proxy URLs.
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

class ZinkMoviesScraper {
  constructor(timeout = 15000) {
    this.timeout = timeout;
    this._lastRequest = 0;
    this._minInterval = 500; // Min 500ms between requests to avoid rate limit
  }

  async _fetch(url, options = {}) {
    // Rate limit: ensure min interval between requests
    const now = Date.now();
    const elapsed = now - this._lastRequest;
    if (elapsed < this._minInterval) {
      await sleep(this._minInterval - elapsed);
    }
    this._lastRequest = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
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

  async _getImdbId(tmdbId, type = 'movie') {
    if (String(tmdbId).startsWith('tt')) return tmdbId;
    const r = await this._fetch(
      `${TMDB_API}/${type}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );
    return JSON.parse(r.body).imdb_id;
  }

  async getInfo(tmdbId, type = 'movie') {
    const r = await this._fetch(
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

  async getMovieStreams(tmdbOrImdbId, title = '') {
    const imdbId = await this._getImdbId(tmdbOrImdbId, 'movie');
    const streams = await this._getGemmaStreams(imdbId);

    const result = [];
    for (const s of streams) {
      try {
        const variants = await this._parseMasterPlaylist(s.url, s.title);
        result.push(...variants);
      } catch {
        result.push({
          title: s.title, quality: 'HLS', url: s.url, source: 'zinkmovies',
          headers: { Referer: STREAM_ORIGIN + '/', Origin: STREAM_ORIGIN },
        });
      }
    }

    result.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

    const meta = await this._safeInfo(tmdbOrImdbId, 'movie');
    const displayTitle = title || meta.title || imdbId;
    for (const r of result) r.title = displayTitle;

    return result;
  }

  async _getGemmaStreams(imdbId) {
    // Retry with backoff when rate-limited. The rasta428jem.com API returns
    // the literal string "7" when it's rate-limiting the caller.
    //
    // IMPORTANT: keep the retry schedule SHORT. The previous [0,1,5,30,60]
    // schedule added up to 96s, which:
    //   - blocks the addon's request slot for too long
    //   - never actually recovers when the IP is heavily rate-limited (cloud IPs)
    //   - still gets killed by StreamResolver's 30s SOURCE_TIMEOUT_MS anyway
    // The new schedule [0, 1, 5] = max 6s. If rasta428jem is rate-limiting us,
    // the user simply sees "no ZinkMovies streams" and the cache (now 60s for
    // empty results, see Source.js) will retry sooner on the next request.
    const delays = [0, 1000, 5000];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        console.error(`Rate limited, waiting ${delays[attempt]/1000}s before retry...`);
        await sleep(delays[attempt]);
      }

      try {
        // Step 1: Get player config
        const r1 = await this._fetch(`${GEMMA_PLAY}/${imdbId}`, {
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

        // Step 2: POST to get sources (must be fast - token expires in ~2s)
        // Temporarily disable rate limiting for this step
        const oldInterval = this._minInterval;
        this._minInterval = 0;
        const r2 = await this._fetch(fileUrl, {
          method: 'POST',
          headers: {
            'X-CSRF-TOKEN': config.key,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://gemma416okl.com',
            'Referer': `${GEMMA_PLAY}/${imdbId}`,
          },
        });

        if (r2.body === '7') {
          this._minInterval = oldInterval;
          throw new Error('Rate limited (got "7")');
        }

        if (!r2.body.startsWith('[')) {
          this._minInterval = oldInterval;
          throw new Error('Invalid response: ' + r2.body.substring(0, 50));
        }

        const sources = JSON.parse(r2.body);
        const baseUrl = fileUrl.substring(0, fileUrl.lastIndexOf('/') + 1);

        // Step 3: Get stream URLs for ALL sources in parallel (racing token expiry)
        const streamPromises = sources
          .filter(s => s.file && s.file.startsWith('~'))
          .map(src => {
            const streamFileUrl = baseUrl + src.file.substring(1) + '.txt';
            return this._fetch(streamFileUrl, {
              method: 'POST',
              headers: {
                'X-CSRF-TOKEN': config.key,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://gemma416okl.com',
                'Referer': `${GEMMA_PLAY}/${imdbId}`,
              },
            }).then(r => ({ title: src.title, url: r.body.trim() }))
              .catch(() => null);
          });

        const results = await Promise.all(streamPromises);
        this._minInterval = oldInterval;

        const valid = results.filter(r => r && r.url && r.url.startsWith('http'));
        if (valid.length > 0) return valid;
        throw new Error('No valid stream URLs');
      } catch (e) {
        if (attempt === delays.length - 1) {
          throw new Error(`Failed after ${delays.length} attempts: ${e.message}`);
        }
      }
    }
  }

  async _parseMasterPlaylist(masterUrl, label) {
    const r = await this._fetch(masterUrl, {
      headers: { Referer: STREAM_ORIGIN + '/', Origin: STREAM_ORIGIN },
    });
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
          else if (h >= 360) quality = '360p';

          streams.push({
            title: label, quality, resolution: currentInf.resolution,
            bandwidth: currentInf.bandwidth, url, source: 'zinkmovies',
            headers: { Referer: STREAM_ORIGIN + '/', Origin: STREAM_ORIGIN },
          });
          currentInf = {};
        }
      }
    }
    return streams;
  }

  async _safeInfo(tmdbOrImdbId, type) {
    try {
      if (String(tmdbOrImdbId).startsWith('tt')) return { title: tmdbOrImdbId };
      return await this.getInfo(tmdbOrImdbId, type);
    } catch {
      return { title: '' };
    }
  }
}

// CLI
if (require.main === module) (async () => {
  const s = new ZinkMoviesScraper();
  const args = process.argv.slice(2);
  const mediaType = args[0] || 'movie';
  const id = args[1] || 'tt0468569';

  console.log('=== ZinkMovies Scraper (Pure Node.js — No Browser, No CF Bypass) ===');
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
      console.log(`Got ${streams.length} stream variants:`);
      for (const st of streams) {
        console.log(`  [${st.quality}] ${st.resolution || ''} ${st.bandwidth || 0} bps`);
        console.log(`    URL: ${st.url}`);
        if (st.headers) console.log(`    Headers: ${JSON.stringify(st.headers)}`);
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
  }
})();

module.exports = { ZinkMoviesScraper };
