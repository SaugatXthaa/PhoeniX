// src/source/VidKing.js
// vidking.net — embeddable video player with TMDB IDs
// Movie: /embed/movie/{tmdbId}
// TV:    /embed/tv/{tmdbId}/{season}/{episode}
//
// The embed page is a React SPA. The VidKing extractor (src/extractor/VidKing.js)
// is responsible for fetching streams from the underlying api.speedracelight.com
// backend. To save a duplicate TMDB round-trip, we pass the title/year/imdbId
// we already resolved here through the meta object.

import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
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

    // Look up title/year and imdb_id in parallel — both are needed by the
    // speedracelight API in the extractor.
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    let imdbId;
    try {
      imdbId = (await getImdbId(this.fetcher, ctx, tmdbId)).id;
    } catch { /* imdb lookup is best-effort */ }

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const url = tmdbId.season
      ? new URL(`/embed/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl)
      : new URL(`/embed/movie/${tmdbId.id}`, this.baseUrl);

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title,
        // Pass-through to the VidKing extractor — saves a duplicate TMDB call.
        // (Extractor falls back to its own lookup if these are missing.)
        vidking: {
          name,
          year,
          ...(imdbId && { imdbId }),
          tmdbId: tmdbId.id,
          ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
        },
      },
    }];
  }
}
