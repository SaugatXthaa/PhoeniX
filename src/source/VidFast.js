// src/source/VidFast.js
// vidfast.vc — embeddable video player with TMDB IDs
// Movie: /movie/{tmdbId}
// TV:    /tv/{tmdbId}/{season}/{episode}
//
// The vidfast.vc embed page is a Next.js React SPA — stream URLs are loaded
// client-side and can't be extracted server-side. We pass meta.vidking so the
// VidKing extractor resolves streams via speedracelight's TMDB-based API.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class VidFast extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vidfast';
    this.label = 'VidFast';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://vidfast.vc';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const url = tmdbId.season
      ? new URL(`/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl)
      : new URL(`/movie/${tmdbId.id}`, this.baseUrl);

    // Only use VidKing/speedracelight fallback for MOVIES.
    // For series/anime, the speedracelight API returns wrong content
    // (e.g. "Supergirl" for Jujutsu Kaisen requests).
    const vidkingMeta = tmdbId.season ? null : {
      name,
      year,
      tmdbId: tmdbId.id,
    };

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title,
        ...(vidkingMeta && { vidking: vidkingMeta }),
      },
    }];
  }
}
