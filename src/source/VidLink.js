// src/source/VidLink.js
// vidlink.pro — TMDB-based movie/TV/anime streaming
//
// Uses the VidLink scraper (src/nuvio/vidlink.cjs) which:
//   1. Encrypts the TMDB ID via enc-dec.app API
//   2. Calls vidlink.pro/api/b/{movie|tv}/{encryptedId}
//   3. Parses the response to get direct MP4/HLS stream URLs
//   4. For M3U8 playlists, fetches and parses quality variants
//
// Streams are on bcdn.hakunaymatata.com — direct MP4 files that play natively.
// No Referer needed for playback.
//
// Enriched metadata (like 4KHDHub):
//   - height: 720, 480, 360 (from quality string)
//   - sourceType: 'WebDL' (streaming rips)
//   - title: movie/show title with quality label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'vidlink.cjs');

// Cache the scraper module — immutable, safe to cache
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[vidlink] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  if (s.includes('1440')) return 1440;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

export class VidLink extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vidlink2';
    this.label = 'VidLink';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://vidlink.pro';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min
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
      console.error(`[vidlink] getStreams error: ${e?.message || e}`);
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
      const qualityLabel = s.quality || (height ? `${height}p` : 'HLS');
      const displayTitle = `${title} (VidLink ${qualityLabel})`;

      // Detect format from URL
      const isHls = s.url.includes('.m3u8') || s.url.includes('/playlist');
      const isMp4 = s.url.includes('.mp4');

      results.push({
        url,
        format: isHls ? Format.hls : (isMp4 ? Format.mp4 : Format.unknown),
        meta: {
          countryCodes: [CountryCode.multi],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          sourceType: 'WebDL',
        },
      });
    }

    return results;
  }
}
