// src/source/FrenchCloud.js
// Ported from research/webstreamr-mbg/src/source/FrenchCloud.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getImdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class FrenchCloud extends Source {
  constructor(fetcher) {
    super();
    this.id = 'frenchcloud';
    this.label = 'FrenchCloud';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.fr];
    this.baseUrl = 'https://frenchcloud.cam';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const imdbId = await getImdbId(this.fetcher, ctx, id);

    const pageUrl = new URL(`/movie/${imdbId.id}`, this.baseUrl);
    const html = await this.fetcher.text(ctx, pageUrl);

    const $ = cheerio.load(html);

    return Promise.all(
      $('[data-link!=""]')
        .map((_i, el) => new URL(($(el).attr('data-link')).replace(/^(https:)?\/\//, 'https://')))
        .toArray()
        .filter(url => !url.host.match(/frenchcloud/))
        .map(url => ({ url, meta: { countryCodes: [CountryCode.fr], referer: this.baseUrl } })),
    );
  }
}
