// src/source/OneDesireMovies.js
// 1desiremovies.wales — movies & TV series with download links (1080p/720p/480p)
//
// Uses the 1desiremovies scraper (src/nuvio/1desiremovies.cjs) which:
//   1. Searches via WP REST API (bypasses Cloudflare on search)
//   2. Fetches post pages via got-scraping
//   3. Extracts quality headings + gyanigurus.online download links
//   4. Each gyanigurus.online URL resolves to hubdrive.tips (handled by HubExtractor)
//
// Enriched metadata (like 4KHDHub):
//   - height: 480, 720, 1080, 2160 (from quality heading)
//   - sourceType: 'BluRay' (1desiremovies typically hosts BluRay rips)
//   - countryCodes: [multi, hi, en] (Hindi-English dual audio)
//   - title: movie/show title with quality label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', '1desiremovies.cjs');

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[1desiremovies] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

export class OneDesireMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'onedesiremovies';
    this.label = '1DesireMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://1desiremovies.wales';
    this.fetcher = fetcher;
    this.ttl = 30 * 60 * 1000; // 30min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module (cached)
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season, tmdbId.episode),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[1desiremovies] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

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
