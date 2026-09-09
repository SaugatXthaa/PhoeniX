// src/source/KMMovies.js
// kmmovies.pics — movies/TV with direct playable MKV streams (up to 4K)
//
// Uses the Nuvio provider (src/nuvio/kmmovies.cjs) which:
//   1. Searches kmmovies.pics by title
//   2. Finds magiclinks.lol URLs (one per quality)
//   3. Resolves magiclinks → direct MKV on Cloudflare R2 + Pixeldrain
//   4. Returns direct playable URLs (no auth/captcha needed for R2 + Pixeldrain)
//
// Stream hosts:
//   ✅ R2 (Cloudflare R2) — directly playable, seekable, no auth
//   ✅ Pixeldrain — directly playable, seekable, no auth
//   ⚠ Vikingfile/Gofile/Skydrop — download-only (need captcha/JS), filtered out
//
// Quality detection from magiclinks page:
//   4K (2160p), 1080p, 720p, 480p — with 10bit/HDR/DV variants
//
// This source returns ONLY directly playable streams (R2 + Pixeldrain).
// Non-playable hosts are filtered out to avoid showing broken streams.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'kmmovies.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[kmmovies] failed to load scraper: ${e?.message || e}`);
  }
  return _scraperMod;
}

// Parse quality string to height integer
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  if (s.includes('1440')) return 1440;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  if (s.includes('360')) return 360;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

// Parse file size from quality text
function parseSize(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
}

// Detect codec from quality text
function parseCodec(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('10bit') || t.includes('10-bit')) return 'HEVC 10bit';
  if (t.includes('x265') || t.includes('h265') || t.includes('hevc')) return 'HEVC';
  if (t.includes('x264') || t.includes('h264')) return 'x264';
  return 'x264';
}

// Detect HDR type
function detectHdr(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('dv') || t.includes('dolby vision')) return 'DolbyVision';
  if (t.includes('hdr10+')) return 'HDR10+';
  if (t.includes('hdr')) return 'HDR';
  return '';
}

export class KMMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'kmmovies';
    this.label = 'KMMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://kmmovies.pics';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') {
      console.error('[kmmovies] scraper module not loaded or missing getStreams export');
      return [];
    }

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 45000)),
      ]);
    } catch (e) {
      console.error(`[kmmovies] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Filter to only directly playable streams (R2 + Pixeldrain)
    // Non-playable hosts (Vikingfile, Gofile, Skydrop) need captcha/JS
    const playableStreams = streams.filter(s => {
      if (s.behaviorHints?.notWebReady) return false; // Skip non-playable
      if (!s.url || !s.url.startsWith('http')) return false;
      return true;
    });

    if (playableStreams.length === 0) {
      console.log(`[kmmovies] ${streams.length} stream(s) from scraper, 0 directly playable`);
      return [];
    }

    // Enrich streams with parsed metadata for buildStreamResults
    const enrichedStreams = playableStreams.map(s => {
      const height = parseHeight(s.quality) || 1080;
      const codec = parseCodec(s.name + ' ' + s.title);
      const hdr = detectHdr(s.name + ' ' + s.title);
      const fileSize = parseSize(s.name + ' ' + s.title);
      const qualityLabel = s.quality || (height + 'p');

      return {
        url: s.url,
        quality: height + 'p',
        title: `[KMMovies ${qualityLabel} ${codec}${hdr ? ' ' + hdr : ''} MKV]`,
        name: s.name || `KMMovies ${qualityLabel}`,
        size: fileSize ? formatBytes(fileSize) : undefined,
        // No Referer needed — R2 and Pixeldrain are direct playable
        headers: {},
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

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'Unknown';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
}
