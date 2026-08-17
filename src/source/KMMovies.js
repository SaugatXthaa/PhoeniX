// src/source/KMMovies.js
// kmmovies.online — movies & TV series with direct Google Drive streams (up to 4K)
//
// The scraper uses native fetch() which gets 403 from kmmovies.online's
// Cloudflare on Render. We override globalThis.fetch with got-scraping
// (using http2: false, which bypasses CF on Render) before calling the scraper,
// then restore it after.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import bytes from 'bytes';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'kmmovies.cjs');

// Override globalThis.fetch with got-scraping (http2: false) for CF bypass
let _gotFetch = null;
async function getGotFetch() {
  if (_gotFetch) return _gotFetch;
  try {
    const { gotScraping } = await import('got-scraping');
    _gotFetch = async (url, options = {}) => {
      try {
        const isManualRedirect = options.redirect === 'manual';
        const res = await gotScraping.get(url, {
          timeout: { request: options.timeout || 25000 },
          throwHttpErrors: false,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': '*/*',
            ...(options.headers || {}),
          },
          followRedirect: !isManualRedirect,
          http2: false,
        });
        // For manual redirects, return the redirect status + location header
        // (got-scraping follows redirects by default, but with followRedirect:false
        // it returns 3xx responses with the location header)
        return {
          ok: isManualRedirect ? (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) : res.statusCode < 400,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          text: async () => res.body,
          json: async () => JSON.parse(res.body),
        };
      } catch (e) {
        return { ok: false, status: 0, statusText: e.message, headers: {}, text: async () => '', json: async () => null };
      }
    };
  } catch (e) {
    console.error('[kmmovies] Failed to load got-scraping for fetch override:', e.message);
  }
  return _gotFetch;
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

// Parse file size string to bytes
function parseSize(size) {
  if (!size || typeof size !== 'string') return undefined;
  try {
    const b = bytes.parse(size);
    return b || undefined;
  } catch { return undefined; }
}

export class KMMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'kmmovies';
    this.label = 'KMMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://kmmovies.online';
    this.fetcher = fetcher;
    this.ttl = 30 * 60 * 1000; // 30min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module (delete cache to pick up changes)
    let mod;
    try {
      delete require_.cache[require_.resolve(PROVIDER_PATH)];
      mod = require_(PROVIDER_PATH);
    } catch (e) {
      console.error(`[kmmovies] failed to load scraper: ${e?.message || e}`);
      return [];
    }
    if (!mod || typeof mod.getStreams !== 'function') return [];

    // Override globalThis.fetch — but only for kmmovies.online URLs.
    // Other URLs (TMDB, /proxy, magiclinks, hubcloud) use the original fetch.
    const originalFetch = globalThis.fetch;
    const gotFetch = await getGotFetch();
    if (gotFetch) {
      globalThis.fetch = function(url, options) {
        var urlStr = typeof url === 'string' ? url : (url && url.href ? url.href : String(url));
        // Use gotFetch for kmmovies.online URLs, original fetch for everything else
        if (urlStr.indexOf('kmmovies.online') !== -1) {
          return gotFetch(url, options);
        }
        return originalFetch(url, options);
      };
    }
    // Set the proxy URL so the scraper can use it for kmmovies.online
    process.env.KM_PROXY_URL = ctx.hostUrl.href + 'proxy';

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season, tmdbId.episode),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[kmmovies] getStreams error: ${e?.message || e}`);
      streams = null;
    } finally {
      // Always restore the original fetch
      globalThis.fetch = originalFetch;
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    const seenUrls = new Set();

    for (const s of streams) {
      if (!s || !s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);

      let url;
      try { url = new URL(s.url); } catch { continue; }

      const height = parseHeight(s.quality);
      const fileSize = parseSize(s.size);

      const qualityLabel = s.quality || (height ? `${height}p` : 'Download');
      const sizeLabel = s.size ? ` [${s.size}]` : '';
      const displayTitle = `${title} (KMMovies ${qualityLabel})${sizeLabel}`;

      results.push({
        url,
        format: Format.mp4,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          sourceType: 'BluRay',
          ...(fileSize && { bytes: fileSize }),
        },
      });
    }

    return results;
  }
}
