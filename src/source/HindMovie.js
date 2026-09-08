// src/source/HindMovie.js
// hindmovie.fit — movies/TV/anime via GDShine API (direct MKV streams, up to 4K)
//
// Uses the scraper (src/nuvio/hindmovie.cjs) which:
//   1. Resolves TMDB → IMDB ID
//   2. For movies: tries iqsmartgames API → HLS streams
//   3. For TV/anime: searches GDShine.org → direct MKV URLs from workers.dev
//
// GDShine streams are direct playable MKV files (video/x-matroska) with
// Accept-Ranges: bytes — Stremio plays them directly.
//
// ENRICHED METADATA (from filename):
//   - height: 480/720/1080/2160
//   - codec: HEVC/x264 (from filename)
//   - sourceType: BluRay/WebDL (from filename)
//   - audioLabel: Dual Audio / Hindi / English
//   - fileSize: from GDShine API

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import bytes from 'bytes';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'hindmovie.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[hindmovie] failed to load scraper: ${e?.message || e}`); }
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

export class HindMovie extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hindmovie';
    this.label = 'HindMovie';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://hindmovie.fit';
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
      console.error(`[hindmovie] error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const enrichedStreams = streams.map(s => {
      const height = parseHeight(s.quality) || parseHeight(s.name + ' ' + s.title) || 1080;
      const labelText = ((s.name || '') + ' ' + (s.title || '')).toLowerCase();
      let codec = 'x264';
      let sourceType = 'WebDL';

      if (labelText.includes('h265') || labelText.includes('hevc') || labelText.includes('x265') || labelText.includes('10bit')) {
        codec = 'HEVC';
      }
      if (labelText.includes('bluray') || labelText.includes('brrip') || labelText.includes('bdrip')) {
        sourceType = 'BluRay';
      }

      let fileSize = undefined;
      const sizeMatch = (s.title || s.name || '').match(/([\d.]+)\s*(GB|MB)/i);
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
      }

      const audioLabel = labelText.includes('dual') || (labelText.includes('hindi') && labelText.includes('english'))
        ? 'Dual Audio' : labelText.includes('hindi') ? 'Hindi' : 'English';

      return {
        url: s.url,
        quality: height + 'p',
        title: `[HindMovie ${height}p ${sourceType} ${codec} ${audioLabel}]`,
        name: 'HindMovie - ' + (s.quality || height + 'p'),
        size: fileSize ? bytes(fileSize) : undefined,
        _countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
        _fileSize: fileSize,
        _sourceType: sourceType,
        _codec: codec,
      };
    });

    const results = buildStreamResults({
      streams: enrichedStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });

    for (const r of results) {
      const matched = enrichedStreams.find(s => s.url === r.url.href);
      if (matched) {
        if (matched._countryCodes) r.meta.countryCodes = matched._countryCodes;
        if (matched._sourceType) r.meta.sourceType = matched._sourceType;
        if (matched._codec) r.meta.codec = matched._codec;
        if (matched._fileSize) r.meta.bytes = matched._fileSize;
      }
    }

    console.log(`[hindmovie] ${results.length} playable stream(s)`);
    return results;
  }
}
