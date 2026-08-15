// src/source/Pahe.js
// pahe.ink — movies & TV with multi-quality download links
//
// Uses the Pahe scraper (src/nuvio/pahe.cjs) which fetches pahe.ink pages
// and extracts download links from teknoasian.com redirectors.
//
// The teknoasian.com URLs are marked as external (browser-openable) by the
// Pahe extractor because they require JS execution to resolve.
//
// Enriched metadata (like 4KHDHub):
//   - height: 720, 1080, 2160 (parsed from quality string)
//   - sourceType: 'BluRay' (Pahe typically hosts BluRay rips)
//   - bytes: file size (parsed from "1.5GB" / "900MB")
//   - countryCodes: [multi, en] (Pahe content is primarily English)
//   - title: movie/show title with quality + host name
//   - subSource: host name (Google Drive, MegaGo, etc.)

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import bytes from 'bytes';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'pahe.cjs');

// Cache the scraper module — immutable, safe to cache
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[pahe] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
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

// Extract host name from stream name (e.g., "Pahe | 720p | Google Drive [1.5GB]")
function extractHostName(name) {
  if (!name) return '';
  const parts = name.split('|');
  if (parts.length >= 3) {
    // "Google Drive [1.5GB]" → "Google Drive"
    const hostPart = parts[2].trim();
    return hostPart.replace(/\s*\[.*?\]\s*$/, '').trim();
  }
  return '';
}

export class Pahe extends Source {
  constructor(fetcher) {
    super();
    this.id = 'pahe';
    this.label = 'Pahe';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://pahe.ink';
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
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[pahe] getStreams error: ${e?.message || e}`);
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
      const hostName = extractHostName(s.name);

      // Build display title: "Movie Title (Year) (Pahe 720p Google Drive)"
      const qualityLabel = s.quality || (height ? `${height}p` : 'Download');
      const displayTitle = hostName
        ? `${title} (Pahe ${qualityLabel} ${hostName})`
        : `${title} (Pahe ${qualityLabel})`;

      results.push({
        url,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          // Pahe typically hosts BluRay/WebDL rips
          sourceType: 'BluRay',
          ...(fileSize && { bytes: fileSize }),
          // subSource: host name (Google Drive, MegaGo, etc.) for display
          ...(hostName && { subSource: hostName }),
        },
      });
    }

    return results;
  }
}
