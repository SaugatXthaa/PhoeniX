// src/source/VegaMovies.js
// vegamovies.enterprises — HD & 4K movie/series downloads
//
// VegaMovies is a DataLife Engine site behind Cloudflare. Search results
// can't be scraped server-side (CF challenge on POST). We pass meta.vidking
// so the VidKing extractor resolves streams via speedracelight's TMDB-based
// API, which has wide coverage of VegaMovies content.
//
// The embed URL uses vegamovies.enterprises as a placeholder — the VidKing
// extractor uses meta.vidking (TMDB ID) to resolve, not the URL itself.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, getImdbId, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class VegaMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vegamovies';
    this.label = 'VegaMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://vegamovies.enterprises';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    let imdbId;
    try {
      imdbId = (await getImdbId(this.fetcher, ctx, tmdbId)).id;
    } catch { /* best-effort */ }

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // VegaMovies search is CF-protected. Use the VidKing extractor's
    // speedracelight API (TMDB-based) to resolve streams. The URL is a
    // placeholder — the VidKing extractor uses meta.vidking, not the URL.
    const url = tmdbId.season
      ? new URL(`/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl)
      : new URL(`/movie/${tmdbId.id}`, this.baseUrl);

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
        title,
        vidking: {
          name,
          year,
          tmdbId: tmdbId.id,
          ...(imdbId && { imdbId }),
          ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
        },
      },
    }];
  }
}
