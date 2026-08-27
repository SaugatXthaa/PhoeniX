// src/source/FlyStream.js
// flystream.net — movies, TV series, anime (sub+dub) with HLS streams up to 4K
//
// Uses the FlyStream API at https://flystream.net/api/playback-search
// Returns HLS m3u8 URLs from media.flystream.net. No Referer needed.
//
// Supports:
//   - Movies (up to 2160p/4K)
//   - TV Series (up to 2160p/4K)
//   - Anime (sub + dub, detected via TMDB original_language=ja + Animation genre)
//   - K-Dramas (via TV series type)
//
// Cloudflare bypass: uses got-scraping + HeaderGenerator + session cookies.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'flystream.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[flystream] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  const m = s.match(/(\d{3,4})p/);
  return m ? parseInt(m[1]) : undefined;
}

export class FlyStream extends Source {
  constructor(fetcher) {
    super();
    this.id = 'flystream';
    this.label = 'FlyStream';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en, CountryCode.ja, CountryCode.ko];
    this.baseUrl = 'https://flystream.net';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Detect anime for metadata enrichment (Japanese audio marker)
    let isAnime = false;
    if (tmdbId.season) {
      try {
        const tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId.id}?api_key=${process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c'}`;
        const { gotScraping } = await import('got-scraping');
        const r = await gotScraping.get(tmdbUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
        });
        if (r.statusCode === 200) {
          const data = JSON.parse(r.body);
          isAnime = data.original_language === 'ja' &&
            (data.genres || []).some(g => g.id === 16);
        }
      } catch { /* best effort */ }
    }

    // Load scraper module (cached)
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    // Resolve IMDB ID for the API (it requires IMDB + title + year)
    let imdbId = '';
    try {
      const { getImdbId } = await import('../utils/index.js');
      const resolvedImdb = await getImdbId(this.fetcher, ctx, tmdbId);
      imdbId = typeof resolvedImdb === 'object' ? resolvedImdb.id : String(resolvedImdb);
    } catch { /* best effort */ }

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null, {
          imdbId,
          title: name,
          year,
          isAnime,
        }),
        new Promise(r => setTimeout(() => r(null), 20000)),
      ]);
    } catch (e) {
      console.error(`[flystream] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Enrich streams with metadata markers for StreamResolver.enrichMeta
    // Same format as 4KHDHub/Cinejoy/FrameX
    if (Array.isArray(streams)) {
      for (const s of streams) {
        const height = parseHeight(s.quality);

        // Build enriched title with metadata markers
        let markers = [];
        if (s.quality) markers.push(s.quality);
        markers.push('WEB-DL');
        if (height === 2160) { markers.push('HEVC'); markers.push('HDR'); }
        else if (s.quality && s.quality.includes('1080')) markers.push('x264');
        else markers.push('x264');

        // Audio language — anime is Japanese, dub is English
        if (s.isDub) {
          markers.push('English');
        } else if (isAnime || s.isSub) {
          markers.push('Japanese');
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
