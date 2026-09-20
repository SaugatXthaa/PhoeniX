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
//   - vixsrc.to: shipped DIRECT with Referer/Origin headers — player-IP
//     delivery (Task 70; CF-blocks datacenter IPs, peraspera class)

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

// Hosts that must be routed differently. Task 70: vixsrc.to REMOVED from
// the dead-filter — production regressed to ZERO desiflix cards because the
// addon's ONLY remaining upstream deliverable class is vixsrc playlists, so
// the filter guaranteed "1 stream(s) from API, 0 after dead-host filter" on
// every title. The old 403 evidence conflated two things: vixsrc.to
// Cloudflare-BLOCKS DATACENTER IPs (verified live: homepage 403 in 0.037s
// from both Render and the sandbox — an edge ASN block, not a token
// rejection), which kills SERVER-side /proxy but NOT the player. The
// standalone VixSrc source has shipped vixsrc playlists since Task 51 via
// meta.nuvioDirectWithHeaders (Task 48 peraspera precedent): the card goes
// DIRECT to the player with Referer/Origin headers and the PLAYER's
// residential IP makes the request — exactly what the real site's browser
// does. desiflix's tokened /playlist/{id}?token=…&expires=… URLs are the
// vixsrc native player format and ride the same path below.
//   - vixsrc.to: NOT filtered — shipped DIRECT with player-IP delivery (see
//     the Task 70 note above and the routing applied after buildStreamResults)

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

    const built = buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });

    // Task 70: vixsrc.to cards ship DIRECT with player-IP delivery.
    // meta.nuvioDirectWithHeaders → NuvioExtractor returns the playlist URL
    // unchanged with requestHeaders {Referer, Origin: vixsrc.to} →
    // behaviorHints.proxyHeaders on the final card (identical to the
    // standalone VixSrc source, Task 51 revival). Server-side /proxy can
    // never work for vixsrc (CF datacenter block) — the player's residential
    // IP is the viable path.
    for (const r of built) {
      if (r?.url && /(^|\.)vixsrc\.to$/i.test(r.url.hostname)) {
        r.meta = {
          ...r.meta,
          nuvioReferer: 'https://vixsrc.to/',
          nuvioOrigin: 'https://vixsrc.to',
          nuvioDirectWithHeaders: true,
        };
      }
    }
    return built;
  }
}
