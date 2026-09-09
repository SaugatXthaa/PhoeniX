// src/source/VideasyTo.js
// videasy.to — movies and TV series with direct playable HLS/MP4 streams (up to 4K)
//
// Uses Playwright headless browser to load player.videasy.to and call the
// speedracelight.com providers' get() function in the browser context.
// This is necessary because the API responses are encrypted with a custom
// stream cipher that's only available in the browser's JS context.
//
// 9 provider backends:
//   Yoru (cdn) | Cypher (downloader2) | Breach (m4uhd) | Neon (vsrc)
//   Vyse (hdmovie-en) | Killjoy (meine-de) | Fade (hdmovie-hi) | Omen (lamovie) | Raze (superflix)
//
// Streams are DIRECT PLAYABLE (no Referer needed) — returned as HLS or MP4
// with enriched metadata (quality up to 4K, subtitles from providers).
//
// This is a SEPARATE source from 'videasy' (which uses player.videasy.net
// with an obfuscated scraper that queries speedracelight servers directly
// without Playwright).

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'videasyto.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module — it has Playwright initialization
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[videasyto] failed to load scraper: ${e?.message || e}`);
  }
  return _scraperMod;
}

// Map quality string to height integer
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  if (s.includes('1440')) return 1440;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  if (s.includes('360')) return 360;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

export class VideasyTo extends Source {
  constructor(fetcher) {
    super();
    this.id = 'videasyto';
    this.label = 'Videasy.to';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://player.videasy.to';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') {
      console.error('[videasyto] scraper module not loaded or missing getStreams export');
      return [];
    }

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      // The scraper queries 10 speedracelight servers in parallel and
      // decrypts responses. Takes 15-25s depending on API response times.
      // PRIORITY_SOURCE_IDS in StreamResolver ensures this starts early.
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 50000)),
      ]);
    } catch (e) {
      console.error(`[videasyto] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Enrich streams with parsed height for buildStreamResults
    const enrichedStreams = streams.map(s => {
      // The scraper returns _is4k flag and quality string — map to height
      let height = parseHeight(s.quality);
      if (!height && s._is4k) height = 2160;
      if (!height) height = 1080; // default

      return {
        ...s,
        // Normalize quality to height+p format for buildStreamResults
        quality: height + 'p',
        // Keep the original type for format detection
        // headers: {} (no Referer needed — direct playable)
        headers: s.headers || {},
      };
    });

    return buildStreamResults({
      streams: enrichedStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
