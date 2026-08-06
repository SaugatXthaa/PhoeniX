// src/source/MostraGuarda.js
// Ported from research/webstreamr-mbg/src/source/MostraGuarda.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

export class MostraGuarda extends Source {
  constructor(fetcher) {
    super();
    this.id = 'mostraguarda';
    this.label = 'MostraGuarda';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.it];
    this.baseUrl = 'https://mostraguarda.stream';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const imdbId = await getImdbId(this.fetcher, ctx, id);

    // Also resolve TMDB info for the VidKing fallback
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    let name, year;
    try {
      [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    } catch { /* best-effort */ }

    const vidkingMeta = {
      ...(name && { name }),
      ...(year && { year }),
      tmdbId: tmdbId.id,
      imdbId: imdbId.id,
    };

    const pageUrl = new URL(`/movie/${imdbId.id}`, this.baseUrl);
    const html = await this.fetcher.text(ctx, pageUrl);

    const $ = cheerio.load(html);

    return Promise.all(
      $('[data-link!=""]')
        .map((_i, el) => new URL(($(el).attr('data-link')).replace(/^(https:)?\/\//, 'https://')))
        .toArray()
        .filter(url => !url.host.match(/mostraguarda/))
        .map(url => ({ url, meta: { countryCodes: [CountryCode.it], referer: this.baseUrl, vidking: vidkingMeta } })),
    );
  }
}
