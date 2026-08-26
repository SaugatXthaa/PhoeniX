// src/source/VixSrc.js
// Ported from research/webstreamr-mbg/src/source/VixSrc.ts

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, supportsMediaFlowProxy, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class VixSrc extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vixsrc';
    this.label = 'VixSrc';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://vixsrc.to';
    this.priority = 1;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    if (!supportsMediaFlowProxy(ctx)) return [];

    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    let title = name;
    if (tmdbId.season) {
      title += ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}`;
    } else {
      title += ` (${year})`;
    }

    const url = tmdbId.season
      ? new URL(`/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl)
      : new URL(`/movie/${tmdbId.id}`, this.baseUrl);

    return [{ url, meta: { title } }];
  }
}
