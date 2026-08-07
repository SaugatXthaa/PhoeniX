// src/source/Einschalten.js
// Ported from research/webstreamr-mbg/src/source/Einschalten.ts

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

export class Einschalten extends Source {
  constructor(fetcher) {
    super();
    this.id = 'einschalten';
    this.label = 'Einschalten';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.de];
    this.baseUrl = 'https://einschalten.in';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    let name, year;
    try {
      [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    } catch { /* best-effort */ }

    const vidkingMeta = {
      ...(name && { name }),
      ...(year && { year }),
      tmdbId: tmdbId.id,
    };

    const { releaseName: title, streamUrl } = await this.fetcher.json(ctx, new URL(`/api/movies/${tmdbId.id}/watch`, this.baseUrl));

    return [{
      url: new URL(streamUrl),
      meta: {
        countryCodes: [CountryCode.de],
        referer: (new URL(`/movies/${tmdbId.id}`, this.baseUrl)).href,
        title,
        ...(vidkingMeta && { vidking: vidkingMeta }),
      },
    }];
  }
}
