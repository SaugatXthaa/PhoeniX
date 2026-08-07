// src/source/CineSu.js
// cine.su — direct m3u8 master playlist provider
//
// Ported from cinepro-org/core/src/providers/cinesu
// CineSu exposes a single direct HLS master playlist per TMDB ID — no
// embed page, no extraction step needed. The URL IS the stream.
//
// URL patterns:
//   Movie: https://cine.su/v1/stream/master/movie/{tmdbId}.m3u8
//   TV:    https://cine.su/v1/stream/master/tv/{tmdbId}/{season}/{episode}.m3u8
//
// The CineSu extractor is a thin passthrough that marks the URL as HLS.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://cine.su';

export class CineSu extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinesu';
    this.label = 'CineSu';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const path = tmdbId.season
      ? `/v1/stream/master/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}.m3u8`
      : `/v1/stream/master/movie/${tmdbId.id}.m3u8`;

    const url = new URL(path, BASE_URL);

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title,
      },
    }];
  }
}
