// src/source/MoviesHuntV2.js
// movieshunt.casa — movies/TV with direct download links (up to 4K)
//
// Uses the all-in-one scraper (src/nuvio/movieshunt_v2.cjs) which:
//   1. Searches via /?s={title}
//   2. Finds abhilinks.site/archives/{id} links with quality labels
//   3. Resolves abhilinks → hubcloud.cx/drive/{id} + gdflix.dev/file/{id}
//   4. Resolves hubcloud → gamerxyt.com → GDrive or pixeldrain
//   5. Resolves gdflix → max.indexserver.site (direct ZIP)

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import bytes from 'bytes';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'movieshunt_v2.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[movieshunt-v2] failed to load scraper: ${e?.message || e}`); }
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

export class MoviesHuntV2 extends Source {
  constructor(fetcher) {
    super();
    this.id = 'movieshuntv2';
    this.label = 'MoviesHunt';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://movieshunt.casa';
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
      console.error(`[movieshunt-v2] error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const enrichedStreams = streams.map(s => {
      const height = parseHeight(s.quality) || 480;
      const codec = height >= 2160 ? 'HEVC' : 'x264';
      let fileSize = undefined;
      const sizeMatch = (s.title || '').match(/([\d.]+)\s*(GB|MB)/i);
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
      }

      return {
        url: s.url,
        quality: height + 'p',
        title: `[MoviesHunt ${height}p WEB-DL ${codec} Hindi-English]`,
        name: 'MoviesHunt - ' + (s.quality || height + 'p'),
        size: fileSize ? bytes(fileSize) : undefined,
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
