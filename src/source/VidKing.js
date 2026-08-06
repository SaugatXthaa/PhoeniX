// src/source/VidKing.js
// vidking.net — embeddable video player with TMDB IDs
// Movie: /embed/movie/{tmdbId}
// TV: /embed/tv/{tmdbId}/{season}/{episode}

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class VidKing extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vidking';
    this.label = 'VidKing';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://www.vidking.net';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const url = tmdbId.season
      ? new URL(`/embed/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl)
      : new URL(`/embed/movie/${tmdbId.id}`, this.baseUrl);

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title,
      },
    }];
  }
}
