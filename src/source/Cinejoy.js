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

    // Load the Cinejoy scraper module
    let Scraper;
    try {
      delete require_.cache[require_.resolve(PROVIDER_PATH)];
      const mod = require_(PROVIDER_PATH);
      Scraper = mod.CinejoyScraper;
    } catch (e) {
      console.error(`[cinejoy] failed to load scraper: ${e?.message || e}`);
      return [];
    }
    if (!Scraper) return [];

    const scraper = new Scraper();

    // Get streams — try Lisbon first (has 4K), then Solara as fallback
    const servers = ['Lisbon', 'Solara', 'Athens'];
    let streams = null;

    for (const server of servers) {
      try {
        streams = await Promise.race([
          tmdbId.season
            ? scraper.getSeriesStreams(String(tmdbId.id), tmdbId.season, tmdbId.episode || 1, server)
            : scraper.getMovieStreams(String(tmdbId.id), server),
          new Promise(r => setTimeout(() => r(null), 20000)),
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
        },
      });
    }

    return results;
  }
}
