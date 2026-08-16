// src/source/OneEmbed.js
// 1embed.cc — movies & TV with multi-quality HLS streams (up to 4K)
//
// Uses the 1Embed scraper (src/nuvio/1embed.cjs) which:
//   1. Acquires a stream token from 1embed.cc/api/token
//   2. Queries 3 servers (Main/VidSrc, Goated, Kaori) in parallel
//   3. Fetches each m3u8 playlist to determine peak resolution
//   4. Returns HLS URLs from proxy.1embed.cc / abdx.tv / cdn.reallyfast.xyz
//
// Requires Referer: https://1embed.cc/ for playback.
//
// Enriched metadata (like 4KHDHub):
//   - height: 2160, 1080, 720, 480, 360 (from m3u8 playlist RESOLUTION)
//   - sourceType: 'WebDL' (HLS streaming rips)
//   - title: movie/show title with quality + server label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', '1embed.cjs');

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[1embed] failed to load scraper: ${e?.message || e}`);
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

export class OneEmbed extends Source {
  constructor(fetcher) {
    super();
    this.id = 'oneembed';
    this.label = '1Embed';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://1embed.cc';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — tokens expire
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
      console.error(`[1embed] getStreams error: ${e?.message || e}`);
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
      const qualityLabel = s.quality || (height ? `${height}p` : 'Auto');
      const displayTitle = `${title} (1Embed ${qualityLabel} · ${s.name?.split(' - ')[1] || 'Main'})`;

      results.push({
        url,
        format: Format.hls,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          sourceType: 'WebDL',
          // Pass Referer via nuvioReferer so NuvioExtractor routes through /proxy
          nuvioReferer: 'https://1embed.cc/',
        },
      });
    }

    return results;
  }
}
