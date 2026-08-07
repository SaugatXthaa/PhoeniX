// src/source/VidSrcTo.js
// vidsrc.to — TMDB-based movie/TV streaming embed
//
// vidsrc.to redirects /embed/movie/{tmdbId} → vsembed.ru/embed/movie/{tmdbId}
// vsembed.ru is already handled by the VidSrc extractor.
// We pass meta.vidking for the VidKing extractor to resolve via speedracelight.
//
// URL patterns:
//   Movie: /embed/movie/{tmdbId}
//   TV:    /embed/tv/{tmdbId}/{season}/{episode}

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class VidSrcTo extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vidsrcto2';
    this.label = 'VidSrcTo';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://vidsrc.to';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const url = tmdbId.season
      ? new URL(`/embed/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl)
      : new URL(`/embed/movie/${tmdbId.id}`, this.baseUrl);

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title,
        vidking: vidkingMeta,
      },
    }];
  }
}
