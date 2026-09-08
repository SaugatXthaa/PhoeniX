// src/source/PersianStremio.js
// persianstremio — Persian-language movies/TV with dual-audio (🇺🇸|🇮🇷) streams
//
// Uses the Nuvio provider (src/nuvio/persianstremio.cjs) which fetches streams
// from persianstremio.vercel.app (a Stremio addon that aggregates Persian
// download links). Returns direct MP4/MKV URLs from:
//   - dl21.cinamadownload.top (BluRay/BrRip)
//   - cdn.aslmd.sbs (Softsub)
//   - *.abrtech.top (TV series)
//
// Streams require Referer: https://persianstremio.vercel.app/ — NuvioExtractor
// routes them through /proxy which sends the Referer header.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'persianstremio.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[persianstremio] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k')) return 2160;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

export class PersianStremio extends Source {
  constructor(fetcher) {
    super();
    this.id = 'persianstremio';
    this.label = 'PersianStremio';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://persianstremio.vercel.app';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(String(tmdbId.id), mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[persianstremio] error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Enrich streams with parsed quality for buildStreamResults
    const enrichedStreams = streams.map(s => {
      const height = parseHeight(s.quality) || parseHeight(s.title) || parseHeight(s.name) || 1080;
      return {
        ...s,
        quality: height + 'p',
        // Keep the scraper's headers (Referer: persianstremio.vercel.app)
        // buildStreamResults will pick up headers.Referer and set nuvioReferer
        headers: s.headers || { 'Referer': 'https://persianstremio.vercel.app/' },
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
