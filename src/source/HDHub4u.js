// src/source/HDHub4u.js
// hdhub4u — movies/series with HubCloud download links
//
// Uses the Nuvio provider (src/nuvio/hdhub4u.cjs) which:
//   1. Searches new1.hdhub4u.af for the movie/TV title
//   2. Fetches the post page → finds hubcloud.cx/drive/{id} links
//   3. Resolves each hubcloud URL via hub_extractor.resolveHubcloudUrl()
//      → hubcloud → gamerxyt → pixel.hubcloud.cx → workers.dev → googleusercontent
//   4. Returns direct video-downloads.googleusercontent.com URL (playable)
//
// The HubCloud page has FSL, FSLv2, PixelDrain, 10Gbps, Download File buttons.
// hub_extractor.resolveHubcloudUrl() follows the full chain and returns the
// googleusercontent.com URL — which is directly playable in Stremio.
//
// Enriched metadata (like 4KHDHub):
//   - height: 480, 720, 1080, 2160 (from quality string)
//   - sourceType: 'BluRay' or 'WebDL' (from heading text)
//   - bytes: file size (from [670MB] / [1.5GB] in heading)
//   - countryCodes: [multi, hi, en] (HDHub4u content is Hindi-English)
//   - title: movie/show title with quality + codec + size + language

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'hdhub4u.cjs');

// Cache the scraper module — it's immutable, safe to cache
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[hdhub4u] failed to load scraper: ${e?.message || e}`);
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
    const m = size.match(/([\d.]+)\s*(GB|MB)/i);
    if (!m) return undefined;
    const val = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    return unit === 'GB' ? Math.round(val * 1024 * 1024 * 1024) : Math.round(val * 1024 * 1024);
  } catch { return undefined; }
}

// Detect source type from heading text
function detectSourceType(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('bluray') || lower.includes('brrip') || lower.includes('bdrip')) return 'BluRay';
  if (lower.includes('web-dl') || lower.includes('webdl') || lower.includes('webrip')) return 'WebDL';
  return 'WebDL';
}

export class HDHub4u extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hdhub4u';
    this.label = 'HDHub4u';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new1.hdhub4u.af';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
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
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 30000)),
      ]);
    } catch (e) {
      console.error(`[hdhub4u] getStreams error: ${e?.message || e}`);
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
      const sourceType = detectSourceType(s.title + ' ' + s.name);

      // Build display title
      const qualityLabel = s.quality || (height ? `${height}p` : 'Download');
      const hostLabel = 'GDrive';
      const displayTitle = `${title} (HDHub4u ${qualityLabel} ${hostLabel})`;

      results.push({
        url,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          sourceType,
          ...(fileSize && { bytes: fileSize }),
        },
      });
    }

    return results;
  }
}
