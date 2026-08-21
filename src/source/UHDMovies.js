// src/source/UHDMovies.js
// uhdmovies — movies-only with 4K and 1080p direct MP4/MKV streams
//
// Uses the Nuvio provider (src/nuvio/uhdmovies.cjs) which returns direct URLs
// from video-downloads.googleusercontent.com. Requires Referer: driveseed.org
//
// Movies-only provider — does not support TV series.
//
// The obfuscated scraper returns stream names with invisible BOM (U+FEFF) and
// zero-width-space (U+200B) chars for anti-debugging, and titles that contain
// the full post text concatenated. We clean these up for proper display.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'uhdmovies.cjs');

// Strip invisible/control chars from a string — BOM, zero-width spaces, etc.
// The obfuscated uhdmovies scraper injects these into stream names as
// anti-debugging watermarks. They break display, sorting, and binge-grouping.
function sanitizeText(text) {
  if (!text) return '';
  let str = String(text);
  // Remove BOM, zero-width chars, word joiners, etc.
  str = str.replace(/[\uFEFF\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u180E\u200E\u200F]/g, '');
  // Normalize non-breaking spaces to regular spaces
  str = str.replace(/[\u00A0\u2028\u2029]/g, ' ');
  // Strip C0/C1 control chars except \t \n \r
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  // Collapse repeated whitespace
  str = str.replace(/\s+/g, ' ').trim();
  return str;
}

// Parse the quality from the stream name/title to get height
function parseHeight(text) {
  const s = String(text || '').toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  const m = s.match(/(\d{3,4})p/);
  return m ? parseInt(m[1]) : undefined;
}

// Parse file size from stream name/title (e.g., "17.5GB" → bytes)
function parseSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return undefined;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (isNaN(val)) return undefined;
  return unit === 'GB' ? Math.round(val * 1024 * 1024 * 1024) : Math.round(val * 1024 * 1024);
}

// Extract the useful part of the title — the scraper concatenates the
// structured metadata with the full post text. We want just the first
// 3 lines (title, quality/size/language, format info).
function cleanTitle(title) {
  if (!title) return '';
  const lines = String(title).split('\n').filter(l => l.trim());
  // Keep first 3 lines (structured metadata), discard the rest (post text dump)
  const usefulLines = lines.slice(0, 3);
  return usefulLines.join(' | ');
}

export class UHDMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'uhdmovies';
    this.label = 'UHDMovies';
    this.contentTypes = ['movie']; // movies-only
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://uhdmovies.co';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // UHDMovies is movies-only — skip if this is a TV series request
    if (tmdbId.season) return [];

    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType: 'movie',
      season: null,
      episode: null,
      timeoutMs: 35000, // UHDMovies resolves via DriveSeed which can be slow
    });

    // Sanitize stream names and titles before buildStreamResults
    // This strips invisible BOM/zero-width chars and cleans up the title format
    if (Array.isArray(streams)) {
      for (const s of streams) {
        if (s.name) s.name = sanitizeText(s.name);
        if (s.size) s.size = sanitizeText(s.size);
        if (s.description) s.description = sanitizeText(s.description);
        // Clean the title: strip invisible chars, then keep only the first
        // 4 lines (structured metadata). The scraper concatenates the full
        // post text into the title — we discard that post-text dump.
        if (s.title) {
          const cleaned = sanitizeText(s.title);
          // Split by the emoji markers (🎬, 🌟, 🎞️, 📝) which delimit lines
          // in the original multi-line title. After sanitizeText collapses
          // newlines to spaces, these markers help us find the boundaries.
          // Keep everything before the first "Download (G Drive)" or "Here you can"
          const cutIdx = cleaned.search(/Download\s*\(G\s*Drive\)|Here you can download/i);
          s.title = cutIdx > 0 ? cleaned.slice(0, cutIdx).trim() : cleaned;
        }
      }
    }

    return buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
