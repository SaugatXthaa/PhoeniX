/**
 * ZinkMovies Scraper for Nuvio — 100% Pure Node.js
 * =================================================
 * NO proxies, NO Playwright, NO browser.
 *
 * Uses gemma416okl.com player API directly (not behind Cloudflare).
 * Returns REAL working HLS streams (verified .m3u8 with multiple qualities).
 *
 * Flow:
 *   1. TMDB → IMDB ID
 *   2. GET gemma416okl.com/play/{imdb} → extract HDVBPlayer config
 *   3. POST rasta428jem.com/playlist/{token}.txt → sources JSON (Hindi/English/etc.)
 *   4. POST rasta428jem.com/playlist/{source}.txt → HLS stream URL
 *   5. Fetch HLS master playlist → 360p/480p/720p/1080p variants
 *
 * Rate Limiting:
 *   The API rate-limits after ~5 rapid requests, returning "7".
 *   Scraper caches for 10 min and retries with 60s backoff.
 *
 * Stream Headers (REQUIRED for playback):
 *   Referer: https://i-arch-400.keymi417exx.com/
 *   Origin: https://i-arch-400.keymi417exx.com
 */

'use strict';

const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const GEMMA_PLAY = 'https://gemma416okl.com/play';
const RASTA_BASE = 'https://rasta428jem.com';
const STREAM_REFERER = 'https://i-arch-400.keymi417exx.com/';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Cache: IMDB ID → {streams, time}
const _cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchText(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, {
      ...options, signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': '*/*', ...options.headers },
    });
    return await r.text();
  } finally { clearTimeout(timer); }
}

async function getTmdbInfo(tmdbId, type) {
  try {
    const r = await fetchText(
      `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
    );
    const d = JSON.parse(r);
    return {
      title: type === 'tv' ? d.name : d.title,
      year: (d.release_date || d.first_air_date || '').slice(0, 4),
      imdbId: d.imdb_id || (d.external_ids && d.external_ids.imdb_id),
    };
  } catch { return { title: '', year: '', imdbId: null }; }
}

function extractConfig(html) {
  let m = html.match(/let p3 = (\{[\s\S]*?\})\s*;/);
  if (m) { try { return JSON.parse(m[1].replace(/\\\//g, '/')); } catch {} }
  m = html.match(/new HDVBPlayer\((\{[\s\S]*?\})\)/);
  if (m) { try { return JSON.parse(m[1].replace(/\\\//g, '/')); } catch {} }
  return null;
}

/**
 * Get raw stream URLs from gemma API.
 * Retries with backoff when rate-limited.
 */
async function getGemmaStreams(imdbId) {
  // Check cache first
  const cached = _cache.get(imdbId);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.streams;
  }

  // Retry with backoff: 0s, 2s, 5s, 15s, 30s, 60s
  const delays = [0, 2000, 5000, 15000, 30000, 60000];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      console.error(`[ZinkMovies] Retrying in ${delays[attempt] / 1000}s (attempt ${attempt + 1}/${delays.length})...`);
      await sleep(delays[attempt]);
    }

    try {
      // Step 1: Get player config
      const html = await fetchText(`${GEMMA_PLAY}/${imdbId}`);
      const config = extractConfig(html);
      if (!config || !config.file || !config.key) {
        throw new Error('No player config');
      }

      let fileUrl = config.file;
      if (!fileUrl.startsWith('http')) {
        fileUrl = RASTA_BASE + fileUrl;
      }

      // Step 2: POST to get sources (token expires fast, do immediately)
      const body = await fetchText(fileUrl, {
        method: 'POST',
        headers: {
          'X-CSRF-TOKEN': config.key,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://gemma416okl.com',
          'Referer': `${GEMMA_PLAY}/${imdbId}`,
        },
      });

      if (body === '7' || !body.startsWith('[')) {
        throw new Error('Rate limited');
      }

      const sources = JSON.parse(body);
      const baseUrl = fileUrl.substring(0, fileUrl.lastIndexOf('/') + 1);

      // Step 3: Get stream URL for each source (sequentially to avoid token expiry)
      const rawStreams = [];
      for (const src of sources) {
        if (!src.file || !src.file.startsWith('~')) continue;
        try {
          const streamBody = await fetchText(baseUrl + src.file.substring(1) + '.txt', {
            method: 'POST',
            headers: {
              'X-CSRF-TOKEN': config.key,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Origin': 'https://gemma416okl.com',
              'Referer': `${GEMMA_PLAY}/${imdbId}`,
            },
          });
          const url = streamBody.trim();
          if (url.startsWith('http')) {
            rawStreams.push({ title: src.title, url });
          }
        } catch {}
      }

      if (rawStreams.length > 0) {
        // Cache the results
        _cache.set(imdbId, { streams: rawStreams, time: Date.now() });
        return rawStreams;
      }

      throw new Error('No stream URLs found');
    } catch (e) {
      if (attempt === delays.length - 1) {
        console.error(`[ZinkMovies] Failed after ${delays.length} attempts: ${e.message}`);
        return [];
      }
    }
  }

  return [];
}

/**
 * Fetch HLS master playlist and parse quality variants.
 */
async function parseHlsPlaylist(masterUrl, label) {
  try {
    const body = await fetchText(masterUrl, {
      headers: { 'Referer': STREAM_REFERER, 'Origin': 'https://i-arch-400.keymi417exx.com' },
    });

    if (!body.includes('#EXTM3U')) return [];

    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const streams = [];
    let currentInf = {};

    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
        const bw = attrs.match(/BANDWIDTH=(\d+)/);
        const res = attrs.match(/RESOLUTION=([^,]+)/);
        currentInf = {
          bandwidth: bw ? parseInt(bw[1]) : 0,
          resolution: res ? res[1] : '',
        };
      } else if (line.startsWith('http') || line.startsWith('./') || line.startsWith('../')) {
        if (currentInf.bandwidth) {
          let url = line;
          if (url.startsWith('./') || url.startsWith('../')) {
            url = new URL(url, masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1)).href;
          }

          const h = currentInf.resolution ? parseInt(currentInf.resolution.split('x')[1]) : 0;
          let quality = 'unknown';
          if (h >= 1080) quality = '1080p';
          else if (h >= 720) quality = '720p';
          else if (h >= 480) quality = '480p';
          else if (h >= 350) quality = '360p';

          streams.push({
            name: `ZinkMovies | ${label} | ${quality}`,
            title: `${label} - ${quality}`,
            quality,
            resolution: currentInf.resolution,
            bandwidth: currentInf.bandwidth,
            url,
            source: 'zinkmovies',
            headers: {
              'Referer': STREAM_REFERER,
              'Origin': 'https://i-arch-400.keymi417exx.com',
            },
          });
          currentInf = {};
        }
      }
    }

    // If no variants found, return master URL as single stream
    if (streams.length === 0) {
      streams.push({
        name: `ZinkMovies | ${label}`,
        title: label,
        quality: 'HLS',
        url: masterUrl,
        source: 'zinkmovies',
        headers: {
          'Referer': STREAM_REFERER,
          'Origin': 'https://i-arch-400.keymi417exx.com',
        },
      });
    }

    return streams;
  } catch {
    return [];
  }
}

/**
 * Nuvio-compatible getStreams function.
 *
 * @param {number} tmdbId - TMDB ID
 * @param {string} type - 'movie' or 'tv'
 * @param {number} season - Season number (for TV)
 * @param {number} episode - Episode number (for TV)
 * @returns {Promise<Array>} Stream objects: {name, title, quality, url, headers, source}
 */
async function getStreams(tmdbId, type, season, episode) {
  const isTV = type === 'tv' || type === 'series';
  const tmdbType = isTV ? 'tv' : 'movie';

  // Get IMDB ID
  const info = await getTmdbInfo(tmdbId, tmdbType);
  const imdbId = info.imdbId || (String(tmdbId).startsWith('tt') ? tmdbId : null);

  if (!imdbId) {
    console.error('[ZinkMovies] No IMDB ID found for TMDB ' + tmdbId);
    return [];
  }

  // Get raw stream URLs from gemma
  const rawStreams = await getGemmaStreams(imdbId);
  if (rawStreams.length === 0) {
    console.error('[ZinkMovies] No streams from gemma API');
    return [];
  }

  // Parse each stream's HLS playlist to get quality variants
  const result = [];
  for (const s of rawStreams) {
    const variants = await parseHlsPlaylist(s.url, s.title);
    result.push(...variants);
  }

  // Sort by quality (highest first)
  const qOrder = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1, 'HLS': 0 };
  result.sort((a, b) => (qOrder[b.quality] || 0) - (qOrder[a.quality] || 0));

  // Set proper title
  const displayTitle = info.title || imdbId;
  for (const r of result) {
    r.title = displayTitle;
    r.size = displayTitle;
    r.description = displayTitle;
  }

  return result;
}

module.exports = { getStreams };
