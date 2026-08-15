// src/source/ZinkMovies.js
// zinkmovies — movies & series with multi-quality HLS streams
//
// Uses the ZinkMovies scraper (src/nuvio/zinkmovies_v2.cjs) which bypasses
// Cloudflare by using the gemma416okl.com player API directly.
//
// Flow:
//   1. Resolve TMDB ID → IMDB ID
//   2. GET https://gemma416okl.com/play/{imdb_id} → HDVBPlayer config
//   3. POST https://rasta428jem.com/playlist/{file} → sources array
//   4. POST https://rasta428jem.com/playlist/{source_file} → stream URL
//   5. Fetch HLS master playlist → 360p/480p/720p/1080p variants
//
// Stream URLs on i-arch-400.rasta428jem.com require:
//   Referer: https://i-arch-400.keymi417exx.com/
//   Origin: https://i-arch-400.keymi417exx.com
//
// The Referer is passed via meta.nuvioReferer so the NuvioExtractor routes
// the stream through /proxy with the Referer header. This ensures both the
// master m3u8 AND all segment requests include the correct Referer.
//
// Enriched metadata (like 4KHDHub):
//   - height: 1080, 720, 480, 360
//   - sourceType: 'WebDL' (HLS streaming rips)
//   - bandwidth: from HLS manifest BANDWIDTH attribute
//   - countryCodes: [multi, hi, en] (ZinkMovies has Hindi + English content)
//   - title: movie/show title with quality label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'zinkmovies_v2.cjs');

// The Referer that the stream CDN requires.
// Without this header, the CDN returns 404 for both the m3u8 and segments.
const STREAM_REFERER = 'https://i-arch-400.keymi417exx.com/';

// Parse quality string to height (matches enrichMeta expectations)
function parseHeight(q) {
  if (!q) return 1080;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : 1080;
}

// Detect audio language from the stream label (e.g., "Hindi", "English", "Tamil")
function detectCountryCodes(label) {
  const codes = [CountryCode.multi, CountryCode.en]; // default: multi + English
  const labelLower = (label || '').toLowerCase();
  if (labelLower.includes('hindi') || labelLower.includes('hin')) {
    codes.push(CountryCode.hi);
  }
  if (labelLower.includes('tamil') || labelLower.includes('tam')) {
    codes.push(CountryCode.ta);
  }
  if (labelLower.includes('telugu') || labelLower.includes('tel')) {
    codes.push(CountryCode.te);
  }
  return [...new Set(codes)];
}

export class ZinkMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'zinkmovies';
    this.label = 'ZinkMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new3.zinkmovies.today';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream URLs have short-lived tokens
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module
    let Scraper;
    try {
      delete require_.cache[require_.resolve(PROVIDER_PATH)];
      const mod = require_(PROVIDER_PATH);
      Scraper = mod.ZinkMoviesScraper;
    } catch (e) {
      console.error(`[zinkmovies] failed to load scraper: ${e?.message || e}`);
      return [];
    }
    if (!Scraper) return [];

    const scraper = new Scraper(15000);

    // Get streams — the scraper handles IMDB ID resolution internally.
    // Pass the display title so the scraper doesn't need to fetch it again.
    let streams;
    try {
      streams = await Promise.race([
        tmdbId.season
          ? scraper.getSeriesStreams(String(tmdbId.id), tmdbId.season, tmdbId.episode || 1, title)
          : scraper.getMovieStreams(String(tmdbId.id), title),
        new Promise(r => setTimeout(() => r(null), 28000)),
      ]);
    } catch (e) {
      console.error(`[zinkmovies] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!streams || !Array.isArray(streams) || streams.length === 0) return [];

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
      const countryCodes = detectCountryCodes(s.name || s.title);
      const referer = s.headers?.Referer || s.headers?.referer || STREAM_REFERER;

      // Build the display title with quality + audio label
      // e.g., "Supergirl (2026) (ZinkMovies Hindi 1080p)"
      const audioLabel = s.name?.split('|')[1]?.trim() || '';
      const qualityLabel = s.quality || `${height}p`;
      const displayTitle = audioLabel
        ? `${title} (ZinkMovies ${audioLabel} ${qualityLabel})`
        : `${title} (ZinkMovies ${qualityLabel})`;

      results.push({
        url,
        format: Format.hls,
        meta: {
          countryCodes,
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          // sourceType: 'WebDL' — these are HLS streaming rips
          sourceType: 'WebDL',
          // Pass the Referer via nuvioReferer so the NuvioExtractor routes
          // through /proxy with the Referer header. This is critical — without
          // the Referer, the CDN returns 404 for the m3u8 and all segments.
          nuvioReferer: referer,
          // bandwidth from HLS manifest (used for sort + display)
          ...(s.bandwidth && { bandwidth: s.bandwidth }),
        },
      });
    }

    return results;
  }
}
