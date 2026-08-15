// src/source/Cinejoy.js
// cinejoy.to — movies and TV series with multi-quality HLS streams (up to 4K)
//
// Uses the new Cinejoy scraper (src/nuvio/cinejoy_v2.cjs) which implements
// the "lumen-gate-v1" protocol via the original cinejoy JS bundle.
// The scraper handles ECDH key exchange, HKDF-SHA256, AES-GCM encryption,
// and the custom block-cipher pipeline internally.
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call scraper.getMovieStreams(tmdbId, server) or getSeriesStreams(tmdbId, s, e, server)
//   3. Returns HLS m3u8 URLs from info.movieboxnoob.cc (no Referer needed)
//   4. Segments use .html extension but are valid MPEG-TS (Content-Type: text/html)
//      → proxy overrides Content-Type to video/mp2t for .html segments
//
// Servers: Lisbon (4K), Solara, Athens, Castle, Sakura (anime), Canaias, Joy
// All streams are direct HLS — no Referer needed, no proxy required.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'cinejoy_v2.cjs');

// Cache the scraper module — the Cinejoy JS bundle is ~500KB and takes ~2-3s to
// parse. Without this cache, every request re-parses the bundle, causing the
// source to take 18-20s instead of 2-3s. The bundle is immutable, so caching is safe.
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[cinejoy] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Cache a shared scraper instance — the Cinejoy scraper does an ECDH handshake
// with api.shegu.st on _init() which takes ~2-3s. Without caching the instance,
// every request creates a new Scraper() and re-handshakes, adding 2-3s to every
// request. The RxClient is designed to be reused (it maintains a session).
let _scraperInstance = null;
async function getScraper() {
  if (_scraperInstance) return _scraperInstance;
  const mod = getScraperModule();
  if (!mod?.CinejoyScraper) return null;
  _scraperInstance = new mod.CinejoyScraper();
  return _scraperInstance;
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return 1080;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : 1080;
}

export class Cinejoy extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinejoy';
    this.label = 'Cinejoy';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://cinejoy.to';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream URLs have short-lived tokens
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Get the shared scraper instance (cached — avoids re-handshake on every request)
    const scraper = await getScraper();
    if (!scraper) return [];

    // Get streams — try Lisbon first (has 4K), then Athens as fallback.
    // IMPORTANT: per-server timeout must be SHORT (12s) because the StreamResolver
    // kills the source at 30s. The previous 25s-per-server schedule meant:
    //   Lisbon (25s) + Solara (25s) + Athens (25s) = 75s worst case
    //   → source always got killed at 30s before reaching Athens/Solara.
    // With 12s for Lisbon + 10s for Athens: 22s total, within the 30s limit.
    // Lisbon usually responds in 1-3s; the 12s timeout handles CPU contention.
    const servers = [
      { name: 'Lisbon', timeout: 12000 },  // has 4K + 1080p
      { name: 'Athens', timeout: 10000 },   // fallback (720p + 480p only)
    ];
    let streams = null;

    for (const { name: server, timeout: serverTimeout } of servers) {
      try {
        streams = await Promise.race([
          tmdbId.season
            ? scraper.getSeriesStreams(String(tmdbId.id), tmdbId.season, tmdbId.episode || 1, server)
            : scraper.getMovieStreams(String(tmdbId.id), server),
          new Promise(r => setTimeout(() => r(null), serverTimeout)),
        ]);
        if (streams && streams.length > 0) break;
      } catch (e) {
        console.error(`[cinejoy] ${server} error: ${e?.message?.slice(0, 80) || e}`);
      }
    }

    if (!streams || streams.length === 0) return [];

    const results = [];
    const seenUrls = new Set();

    for (const s of streams) {
      if (!s.url || typeof s.url !== 'string') continue;
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);

      let url;
      try { url = new URL(s.url); } catch { continue; }

      const height = parseHeight(s.quality);

      // Cinejoy streams are on info.movieboxnoob.cc — direct HLS, no Referer needed.
      // Return the ORIGINAL URL (not /proxy) so the DirectStream extractor handles it.
      // The .m3u8 has .html segment URLs which the proxy already overrides
      // Content-Type to video/mp2t for.
      results.push({
        url,
        format: Format.hls,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.en],
          title: `${title} (Cinejoy ${s.quality || '1080p'})`,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          // sourceType: 'WebDL' — these are HLS streaming rips
          sourceType: 'WebDL',
          // bandwidth from HLS manifest (used for sort + display)
          ...(s.bandwidth && { bandwidth: s.bandwidth }),
        },
      });
    }

    return results;
  }
}
