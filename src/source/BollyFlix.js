// src/source/BollyFlix.js
// bollyflix.free — movies & TV with multi-quality download links (up to 4K)
//
// Uses the BollyFlix scraper (src/nuvio/bollyflix.cjs) which:
//   1. Resolves the current BollyFlix domain from domains.json
//   2. Searches via /search/{title}
//   3. Fetches the post page → extracts download links from <h4>/<h5> headings
//   4. Returns download links from dl.fastdlserver.site (GDrive)
//
// The fastdlserver URLs are resolved by the Pantyflix extractor (which already
// handles fastdlserver → gdflix → cloud-dl workers.dev redirect chain).
//
// Enriched metadata (like 4KHDHub):
//   - height: 480, 720, 1080, 2160 (from quality string)
//   - sourceType: 'BluRay' or 'WebDL' (from heading text)
//   - bytes: file size (from [520MB] / [1.5GB] in heading)
//   - countryCodes: [multi, hi, en] (BollyFlix content is Hindi-English)
//   - title: movie/show title with quality + host label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import bytes from 'bytes';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'bollyflix.cjs');

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[bollyflix] failed to load scraper: ${e?.message || e}`);
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

// Detect source type from heading text
function detectSourceType(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('bluray') || lower.includes('brrip') || lower.includes('bdrip')) return 'BluRay';
  if (lower.includes('web-dl') || lower.includes('webdl') || lower.includes('webrip')) return 'WebDL';
  return 'WebDL';
}

export class BollyFlix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'bollyflix';
    this.label = 'BollyFlix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://bollyflix.free';
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
      console.error(`[bollyflix] getStreams error: ${e?.message || e}`);
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
      const hostLabel = s.name?.split(' ').pop() || 'GDrive';
      const displayTitle = `${title} (BollyFlix ${qualityLabel} ${hostLabel})`;

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
          // Don't set nuvioReferer — the fastdlserver URLs are handled by
          // the Pantyflix extractor which resolves them to direct cloud-dl
          // workers.dev URLs (fastdlserver → gdflix → cloud-dl workers.dev).
          // Setting nuvioReferer would make NuvioExtractor claim them first
          // and route through /proxy, which gets 403 from fastdlserver.
        },
      });
    }

    return results;
  }
}
