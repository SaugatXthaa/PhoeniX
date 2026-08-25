// src/source/FrameX.js
// framextv.tech — movies, TV series, anime (sub+dub) with HLS streams up to 4K
//
// Uses the FrameX API at https://api.framextv.tech/api/stream
// Returns HLS m3u8 URLs with Referer headers (for moon.peakstorm.top CDN).
//
// Supports:
//   - Movies (up to 2160p/4K)
//   - TV Series (up to 2160p/4K)
//   - Anime (sub + dub, via AniList ID mapping)
//   - K-Dramas (via TV series type)
//
// Stream URLs from moon.peakstorm.top require Referer: https://player.videasy.to/
// This is passed via meta.nuvioReferer so NuvioExtractor routes through /proxy.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'framextv.cjs');

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  const m = s.match(/(\d{3,4})p/);
  return m ? parseInt(m[1]) : undefined;
}

export class FrameX extends Source {
  constructor(fetcher) {
    super();
    this.id = 'framextv';
    this.label = 'FrameX';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en, CountryCode.ja, CountryCode.ko];
    this.baseUrl = 'https://framextv.tech';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load scraper module (cached via nuvioHelpers)
    const { callNuvioProvider } = await import('./nuvioHelpers.js');

    // Determine type: anime detection via original_language
    // TMDB's original_language = 'ja' + type = 'tv' → anime
    let apiType = tmdbId.season ? 'tv' : 'movie';
    if (tmdbId.season) {
      // Check if this is anime (Japanese origin)
      try {
        const tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId.id}?api_key=${process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c'}`;
        const { gotScraping } = await import('got-scraping');
        const r = await gotScraping.get(tmdbUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
        });
        if (r.statusCode === 200) {
          const data = JSON.parse(r.body);
          // Japanese anime: original_language=ja + genres include Animation (16)
          const isAnime = data.original_language === 'ja' &&
            (data.genres || []).some(g => g.id === 16);
          if (isAnime) {
            apiType = 'anime';
          }
        }
      } catch { /* best effort */ }
    }

    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType: apiType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      timeoutMs: 30000, // Movies/TV are fast (~2s). Anime may timeout.
    });

    // Enrich streams with metadata markers for StreamResolver.enrichMeta
    // Same format as 4KHDHub/Cinejoy
    if (Array.isArray(streams)) {
      for (const s of streams) {
        // Parse quality markers from the stream name/title
        const height = parseHeight(s.quality);
        const serverName = s.server || s.name || '';

        // Build enriched title with metadata markers
        let markers = [];
        if (s.quality) markers.push(s.quality);
        markers.push('WEB-DL');
        if (height === 2160) { markers.push('HEVC'); markers.push('HDR'); }
        else if (s.quality && s.quality.includes('1080')) markers.push('x264');
        else markers.push('x264');

        // Audio language
        if (s.category === 'sub' || apiType === 'anime') {
          markers.push('Japanese');
        } else if (s.category === 'dub') {
          markers.push('English');
        } else {
          markers.push('English');
        }

        // Append markers to title for enrichMeta parsing
        s.title = (s.title || '') + ' ' + markers.join(' ');
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
