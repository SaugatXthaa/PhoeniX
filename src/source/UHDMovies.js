// src/source/UHDMovies.js
// uhdmovies — movies (Hindi/English) with 4K and 1080p direct MP4/MKV streams
//
// Uses the Nuvio provider (src/nuvio/uhdmovies.cjs) which returns direct URLs
// from video-downloads.googleusercontent.com. Requires Referer: driveseed.org
//
// Movies-only provider — does not support TV series.
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'movie', null, null)
//   3. Parse the scraper's emoji-heavy title format and extract clean metadata
//   4. Convert streams to Source result format via buildStreamResults()

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'uhdmovies.cjs');

// Parse the scraper's emoji-heavy title to extract clean metadata.
// The scraper returns titles like:
//   "🎬 Inception (2010)\n🌟 2160p | 📦 17.5GB | 🗣️ HI • EN\n🎞️ MKV | ⚡"
// We parse this to extract quality, size, audio, codec, format, sourceType.
function parseScraperTitle(scraperTitle, movieTitle) {
  const text = scraperTitle || '';
  const lower = text.toLowerCase();

  // Extract quality (2160p, 1080p, 720p, 480p)
  let height = 1080;
  if (lower.includes('2160') || lower.includes('4k') || lower.includes('uhd')) height = 2160;
  else if (lower.includes('1080')) height = 1080;
  else if (lower.includes('720')) height = 720;
  else if (lower.includes('480')) height = 480;

  // Extract quality label (e.g., "2160p", "1080p")
  const qualityLabel = height >= 2160 ? '4K' : `${height}p`;

  // Extract file size (e.g., "17.5GB", "520MB")
  let sizeStr = '';
  const sizeMatch = text.match(/([\d.]+)\s*(GB|MB|TB)/i);
  if (sizeMatch) {
    sizeStr = `${sizeMatch[1]}${sizeMatch[2].toUpperCase()}`;
  }

  // Extract audio info (HI • EN = Hindi + English, EN = English, HI = Hindi)
  let audioLabel = '';
  const hasHindi = /hin|hi\b|hindi/i.test(text) || /🗣️\s*HI/i.test(text);
  const hasEnglish = /eng|en\b|english/i.test(text) || /🗣️\s*.*EN/i.test(text);
  if (hasHindi && hasEnglish) audioLabel = 'Hindi-English';
  else if (hasHindi) audioLabel = 'Hindi';
  else if (hasEnglish) audioLabel = 'English';

  // Extract codec (HEVC/x265, x264/AVC, AV1)
  let codec = '';
  if (lower.includes('hevc') || lower.includes('x265') || lower.includes('h265')) codec = 'HEVC';
  else if (lower.includes('x264') || lower.includes('h264') || lower.includes('avc')) codec = 'AVC';
  else if (lower.includes('av1')) codec = 'AV1';

  // Extract format (MKV, MP4)
  let format = '';
  if (lower.includes('mkv')) format = 'MKV';
  else if (lower.includes('mp4')) format = 'MP4';

  // Extract HDR info
  let hdr = '';
  if (lower.includes('dolby vision') || lower.includes(' dv ')) hdr = 'Dolby Vision';
  else if (lower.includes('hdr10+')) hdr = 'HDR10+';
  else if (lower.includes('hdr')) hdr = 'HDR';

  // Detect source type
  let sourceType = 'WebDL';
  if (lower.includes('bluray') || lower.includes('brrip') || lower.includes('bdrip')) sourceType = 'BluRay';
  else if (lower.includes('web-dl') || lower.includes('webdl') || lower.includes('webrip')) sourceType = 'WebDL';

  // Build a clean title like 4KHDHub format:
  // "Inception (2010) 2160p HEVC HDR Hindi-English [17.5GB] MKV"
  const parts = [movieTitle];
  parts.push(qualityLabel);
  if (codec) parts.push(codec);
  if (hdr) parts.push(hdr);
  if (audioLabel) parts.push(audioLabel);
  if (sizeStr) parts.push(`[${sizeStr}]`);
  if (format) parts.push(format);

  return {
    cleanTitle: parts.join(' '),
    height,
    sizeStr,
    codec,
    hdr,
    audioLabel,
    format,
    sourceType,
  };
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
      timeoutMs: 25000, // cap at 25s
    });

    // The scraper returns emoji-heavy titles. We parse them to extract clean
    // metadata and replace the title with a clean format (like 4KHDHub).
    if (Array.isArray(streams)) {
      for (const s of streams) {
        if (s.title && typeof s.title === 'string') {
          const parsed = parseScraperTitle(s.title, title);
          // Replace the emoji-heavy title with the clean format
          s.title = parsed.cleanTitle;
          // Also update s.name to remove emojis
          if (s.name) {
            s.name = s.name.replace(/[🎬🌟📦🗣️🎞️⚡🔥💎📺🌐📥🔗]/gu, '').trim();
          }
          // Store parsed metadata for buildStreamResults to pick up
          if (parsed.sizeStr) s.size = parsed.sizeStr;
          // Add quality hint for buildStreamResults height parsing
          if (!s.quality || s.quality === '') {
            s.quality = parsed.height >= 2160 ? '2160p' : `${parsed.height}p`;
          }
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
