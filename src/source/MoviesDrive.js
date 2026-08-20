// src/source/MoviesDrive.js
// moviesdrive — movies/series via new2.moviesdrive.christmas
//
// Uses the Nuvio scraper (src/nuvio/moviesdrive.cjs) which:
//   1. Resolves TMDB ID → title/year via TMDB API
//   2. Searches MoviesDrive via WordPress REST API
//   3. Fetches movie page → finds archive links (mdrive.lol, direct hubcloud,
//      or search-recover.php URLs)
//   4. For each archive: resolves to hubcloud.cx/drive/{id}
//   5. Resolves hubcloud URL → gamerxyt → pixel.hubcloud.cx → workers.dev →
//      video-downloads.googleusercontent.com (direct playable GDrive URL)
//
// The scraper uses hub_extractor_full.cjs which handles the full resolution
// chain with got-scraping (Chrome TLS fingerprint) for Cloudflare bypass.
//
// Honeypot detection: When a movie has been DMCA-removed from HubCloud, the
// search-recover.php API returns a fake "Three Thousand Years of Longing"
// file (ID: 9fm1fbqq04e9qq_). The scraper detects and skips these so we
// return 0 streams instead of wrong-movie streams.
//
// Stream URL routing:
//   - googleusercontent.com URLs: direct playable, no Referer needed
//   - NuvioExtractor handles them as direct URLs (no /proxy)

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'moviesdrive.cjs');

export class MoviesDrive extends Source {
  constructor(fetcher) {
    super();
    this.id = 'moviesdrive';
    this.label = 'MoviesDrive';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new2.moviesdrive.christmas';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — scraper resolves to direct GDrive URLs
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      timeoutMs: 30000, // scraper does multiple resolution steps, allow 30s
    });

    return buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
