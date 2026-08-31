// src/source/MoviesDriveV2.js
// new3.moviesdrive.christmas — movies/TV with direct download links (up to 4K)
//
// Uses the all-in-one scraper (src/nuvio/moviesdrive_v2.cjs) which:
//   1. Searches via WP REST API /wp-json/wp/v2/posts?search={title}
//   2. Finds hubcloud.foo/drive/search-recover.php links with base64-encoded quality
//   3. Decodes base64 → quality (e.g. "Inception 2010 1080p")
//   4. HubCloud API: ?api=search&q={query} → file list with sizes
//   5. Resolves hubcloud.cx/drive/{id} → gamerxyt → GDrive (googleusercontent)

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import bytes from 'bytes';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'moviesdrive_v2.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[moviesdrive-v2] failed to load scraper: ${e?.message || e}`); }
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

export class MoviesDriveV2 extends Source {
  constructor(fetcher) {
    super();
    this.id = 'moviesdrivev2';
    this.label = 'MoviesDrive';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new3.moviesdrive.christmas';
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
      console.error(`[moviesdrive-v2] error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const enrichedStreams = streams.map(s => {
      const height = parseHeight(s.quality) || 1080;
      const codec = height >= 2160 ? 'HEVC' : 'x264';
      let fileSize = undefined;
      const sizeMatch = (s.title || s.name || '').match(/([\d.]+)\s*(GB|MB)/i);
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
      }

      return {
        url: s.url,
        quality: height + 'p',
        title: `[MoviesDrive ${height}p WEB-DL ${codec} Hindi-English]`,
        name: 'MoviesDrive - ' + (s.quality || height + 'p'),
        size: fileSize ? bytes(fileSize) : undefined,
        headers: (s.url || '').includes('googleusercontent') ? { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } : undefined,
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
