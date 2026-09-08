// src/source/DesiFlix.js
// desiflix — movies, TV series, and anime with multi-audio HLS/MP4 streams
//
// Uses the Nuvio provider (src/nuvio/desiflix.cjs) which fetches streams from
// manifest.desitvhub.eu.org. The API is a Stremio addon that aggregates
// multiple upstream providers (vixsrc.to, flixsix.com, moviezzwaphd.xyz,
// vcdnx.com, peakstorm.top, etc.) and returns mixed HLS + MP4 streams.
//
// The scraper uses Node's native https module with retry-on-cold-start logic
// (the Azure Container App backend returns 504 for the first ~10s after idle,
// then warms up and serves fast 200s).
//
// Stream URL routing (handled by buildStreamResults in nuvioHelpers.js):
//   - s*.flixsix.com: direct MP4, no Referer needed → DirectStream
//   - manifest.desitvhub.eu.org/api/rpmplay/hls: direct HLS (proxied m3u8) → DirectStream
//   - manifest.desitvhub.eu.org/api/stream: proxied MP4 → DirectStream
//   - vixsrc.to: FILTERED OUT (returns 403 Cloudflare-blocked even with Referer)

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'desiflix.cjs');

// Cache the scraper module — it's immutable, safe to cache.
// NOTE: Do NOT delete require_.cache here — clearing the cache forces a module
// reload on every call, which breaks scrapers that have initialization side
// effects. The module code doesn't change between requests.
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[desiflix] failed to load scraper: ${e?.message || e}`);
  }
  return _scraperMod;
}

// Hosts that consistently fail and should be filtered out before returning
// streams to the user. Keeping these would show broken/unplayable streams.
//
//   - vixsrc.to: returns 403 Forbidden (Cloudflare-blocked, even with
//     Referer: https://vixsrc.to/). The token format from desiflix doesn't
//     match what vixsrc.to expects, so all requests are rejected.
const DEAD_HOSTS = /vixsrc\.to/i;

export class DesiFlix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'desiflix';
    this.label = 'DesiFlix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://manifest.desitvhub.eu.org';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min — streams have short-lived tokens
    this.domainKey = 'nuvio_desiflix';
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module (cached)
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') {
      console.error('[desiflix] scraper module not loaded or missing getStreams export');
      return [];
    }

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      // The scraper has built-in retry logic for cold-start 504s (12s timeout
      // per attempt × 3 retries with 2s backoff = ~40s worst case). We give
      // it 45s total to accommodate the full retry cycle.
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 45000)),
      ]);
    } catch (e) {
      console.error(`[desiflix] getStreams error: ${e?.message || e}`);
      streams = null;
    }

    if (!Array.isArray(streams)) return [];

    // Filter out streams from dead/unreliable CDN hosts that cause 403/522 errors.
    // vixsrc.to is the main offender — it returns 403 for all desiflix tokens.
    const filteredStreams = streams.filter(s => {
      if (!s || !s.url) return false;
      try {
        const host = new URL(s.url).hostname;
        return !DEAD_HOSTS.test(host);
      } catch { return false; }
    });

    if (filteredStreams.length === 0) {
      console.log(`[desiflix] ${streams.length} stream(s) from API, 0 after dead-host filter`);
      return [];
    }

    return buildStreamResults({
      streams: filteredStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
