// src/source/AnikotoTV.js
// anikototv — anime with sub+dub HLS streams
//
// Uses the Nuvio provider (src/nuvio/anikototv.cjs) which resolves TMDB→MAL via
// AniList, then fetches HLS from megap.akirax.buzz. Returns both SUB (Japanese
// audio) and DUB (English audio) streams.
// Requires Referer: https://megaplay.buzz/
//
// Anime-only provider — only runs for content that is actually anime (has the
// "Animation" genre in TMDB or has original_language=ja). This prevents
// AnikotoTV from showing anime streams for non-anime content like "House of
// the Dragon" which the AniList search would falsely match.
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Check TMDB genres — skip if not anime (no Animation genre + not Japanese)
//   3. Call provider.getStreams(tmdbId, 'tv', season, episode)
//   4. Convert streams to Source result format via buildStreamResults()

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'anikototv.cjs');

// TMDB genre IDs for Animation (16) — present on all anime entries
const ANIMATION_GENRE_ID = 16;

// Check if TMDB content is actually anime by fetching its genres + language.
// Returns true if the content has the "Animation" genre OR original_language=ja.
// This prevents false matches from the scraper's AniList search (which would
// otherwise return anime results for non-anime titles like "House of the Dragon").
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c');
    const data = await fetcher.json(ctx, url);
    if (!data) return false;

    // Check genres for Animation (ID 16)
    const genres = data.genres || [];
    const hasAnimationGenre = genres.some(g => g.id === ANIMATION_GENRE_ID);
    if (hasAnimationGenre) return true;

    // Also accept Japanese-origin content (original_language = ja)
    // even without Animation genre (some anime entries are missing it)
    if (data.original_language === 'ja') return true;

    return false;
  } catch {
    // If TMDB fetch fails, be permissive (don't block anime that might work)
    return true;
  }
}

export class AnikotoTV extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anikototv';
    this.label = 'AnikotoTV';
    this.contentTypes = ['series']; // anime-only
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = 'https://anikototv.com';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // AnikotoTV is anime-only — requires season/episode
    if (!tmdbId.season) return [];

    // Check if this content is actually anime before proceeding.
    // Without this check, the scraper's AniList search would match non-anime
    // titles (e.g. "House of the Dragon") to unrelated anime entries, showing
    // wrong anime streams for non-anime content.
    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);
    if (!isAnime) return [];

    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType: 'tv',
      season: tmdbId.season,
      episode: tmdbId.episode || 1,
      timeoutMs: 25000, // stay under 30s source timeout
    });

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
