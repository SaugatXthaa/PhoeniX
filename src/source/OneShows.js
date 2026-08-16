// src/source/OneShows.js
// 1shows — movies & TV with direct download links (PixelDrain)
//
// Uses the 1Shows scraper (src/nuvio/1shows.cjs) which returns direct
// PixelDrain URLs (pixeldrain.com/api/file/{id}).
//
// PixelDrain URLs are direct MP4 files — no Referer needed, plays natively.
// The DirectStream extractor handles pixeldrain.com URLs.
//
// Enriched metadata (like 4KHDHub):
//   - height: 480 (default from scraper — 1Shows typically returns 480p)
//   - sourceType: 'WebDL' (direct download rips)
//   - title: movie/show title with quality + host label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', '1shows.cjs');

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[1shows] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Parse quality from stream name (e.g. "1Shows • 480p • Pixeldrain")
function parseHeight(name) {
  if (!name) return 480;
  const m = String(name).match(/(\d{3,4})p/i);
  if (m) return parseInt(m[1]);
  if (/4k|2160/i.test(name)) return 2160;
  return 480;
}

// Extract host label from stream name
function extractHost(name) {
  if (!name) return 'PixelDrain';
  const parts = String(name).split('•').map(s => s.trim());
  return parts[2] || parts[1] || 'PixelDrain';
}

export class OneShows extends Source {
  constructor(fetcher) {
    super();
    this.id = 'oneshows';
    this.label = '1Shows';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://1shows.cc';
    this.fetcher = fetcher;
    this.ttl = 30 * 60 * 1000; // 30min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module (cached)
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season, tmdbId.episode),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[1shows] getStreams error: ${e?.message || e}`);
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

      const height = parseHeight(s.name || s.title);
      const hostLabel = extractHost(s.name);
      const qualityLabel = `${height}p`;
      const displayTitle = `${title} (1Shows ${qualityLabel} ${hostLabel})`;

      results.push({
        url,
        format: Format.mp4,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          sourceType: 'WebDL',
        },
      });
    }

    return results;
  }
}
