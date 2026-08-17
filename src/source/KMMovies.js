// src/source/KMMovies.js
// kmmovies.online — movies & TV series with direct Google Drive streams (up to 4K)
//
// Uses the KMMovies scraper (src/nuvio/kmmovies.cjs) which:
//   1. Searches kmmovies.online/?s={title} (uses curl with full browser headers)
//   2. Fetches post → extracts magiclinks.lol download links with quality/size
//   3. Resolves each: magiclinks → hubcloud → gamerxyt → pixel → workers → googleusercontent
//   4. Returns direct Google Drive download URLs (MKV/MP4)
//
// Supports: movies, TV series, up to 4K/2160p when available.
//
// Enriched metadata (like 4KHDHub):
//   - height: 480, 720, 1080, 2160 (from quality string)
//   - sourceType: 'BluRay' (KMMovies typically hosts BluRay rips)
//   - bytes: file size (from [539.4MB] / [1.5GB] in heading)
//   - countryCodes: [multi, hi, en] (Hindi-English dual audio)
//   - title: movie/show title with quality + size label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import bytes from 'bytes';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'kmmovies.cjs');

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[kmmovies] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

// Parse file size string to bytes
function parseSize(size) {
  if (!size || typeof size !== 'string') return undefined;
  try {
    const b = bytes.parse(size);
    return b || undefined;
  } catch { return undefined; }
}

export class KMMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'kmmovies';
    this.label = 'KMMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://kmmovies.online';
    this.fetcher = fetcher;
    this.ttl = 30 * 60 * 1000; // 30min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module (delete cache to pick up changes)
    let mod;
    try {
      delete require_.cache[require_.resolve(PROVIDER_PATH)];
      mod = require_(PROVIDER_PATH);
    } catch (e) {
      console.error(`[kmmovies] failed to load scraper: ${e?.message || e}`);
      return [];
    }
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season, tmdbId.episode),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[kmmovies] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    const seenUrls = new Set();

    for (const s of streams) {
      if (!s || !s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);

      let url;
      try { url = new URL(s.url); } catch { continue; }

      const height = parseHeight(s.quality);
      const fileSize = parseSize(s.size);

      // Build display title like 4KHDHub format
      const qualityLabel = s.quality || (height ? `${height}p` : 'Download');
      const sizeLabel = s.size ? ` [${s.size}]` : '';
      const displayTitle = `${title} (KMMovies ${qualityLabel})${sizeLabel}`;

      results.push({
        url,
        format: Format.mp4,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          sourceType: 'BluRay',
          ...(fileSize && { bytes: fileSize }),
        },
      });
    }

    return results;
  }
}
