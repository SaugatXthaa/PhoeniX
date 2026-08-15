// src/source/ZinkMovies.js
// zinkmovies — movies, series, anime, K-drama with multi-quality HLS streams
//
// Uses the new ZinkMovies scraper (src/nuvio/zinkmovies_v2.cjs) which bypasses
// Cloudflare by using the gemma416okl.com player API directly (not behind CF).
//
// Flow:
//   1. Resolve TMDB ID → IMDB ID
//   2. GET https://gemma416okl.com/play/{imdb_id} → HDVBPlayer config
//   3. POST https://rasta428jem.com/playlist/{file} → sources array
//   4. POST https://rasta428jem.com/playlist/{source_file} → stream URL
//   5. Fetch HLS master playlist → 360p/480p/720p/1080p variants
//
// Stream URLs on i-arch-400.rasta428jem.com require:
//   Referer: https://i-arch-400.keymi417exx.com/
//   Origin: https://i-arch-400.keymi417exx.com
//
// The scraper has built-in rate-limit retry logic (1s, 5s, 30s, 60s delays).

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'zinkmovies_v2.cjs');

// Parse quality string to height
function parseHeight(q) {
  if (!q) return 1080;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : 1080;
}

export class ZinkMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'zinkmovies';
    this.label = 'ZinkMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new3.zinkmovies.today';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream URLs have short-lived tokens
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module
    let Scraper;
    try {
      delete require_.cache[require_.resolve(PROVIDER_PATH)];
      const mod = require_(PROVIDER_PATH);
      Scraper = mod.ZinkMoviesScraper;
    } catch (e) {
      console.error(`[zinkmovies] failed to load scraper: ${e?.message || e}`);
      return [];
    }
    if (!Scraper) return [];

    const scraper = new Scraper(15000);

    // Get streams — the scraper handles IMDB ID resolution internally
    // Use TMDB ID directly (scraper resolves to IMDB ID via TMDB API)
    const tmdbOrImdb = tmdbId.id;

    let streams;
    try {
      streams = await Promise.race([
        scraper.getMovieStreams(String(tmdbOrImdb)),
        new Promise(r => setTimeout(() => r(null), 28000)),
      ]);
    } catch (e) {
      console.error(`[zinkmovies] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!streams || !Array.isArray(streams) || streams.length === 0) return [];

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
      const referer = s.headers?.Referer || s.headers?.referer || '';
      const origin = s.headers?.Origin || s.headers?.origin || '';

      // Route through /proxy with Referer for HLS playback
      // (Stremio's ffmpeg doesn't send Referer for HLS sub-requests)
      if (referer) {
        const proxyUrl = new URL('/proxy', ctx.hostUrl);
        proxyUrl.searchParams.set('url', url.href);
        proxyUrl.searchParams.set('referer', referer);

        results.push({
          url: proxyUrl,
          format: Format.hls,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
            title: `${title} (ZinkMovies ${s.quality || 'HLS'})`,
            sourceId: this.id,
            sourceLabel: this.label,
            height,
            ...(s.bandwidth && { bandwidth: s.bandwidth }),
          },
        });
      } else {
        // Direct URL — no Referer needed
        results.push({
          url,
          format: Format.hls,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
            title: `${title} (ZinkMovies ${s.quality || 'HLS'})`,
            sourceId: this.id,
            sourceLabel: this.label,
            height,
            ...(s.bandwidth && { bandwidth: s.bandwidth }),
          },
        });
      }
    }

    return results;
  }
}
