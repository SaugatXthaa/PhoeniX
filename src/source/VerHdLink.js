// src/source/VerHdLink.js
// Ported from research/webstreamr-mbg/src/source/VerHdLink.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getImdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class VerHdLink extends Source {
  constructor(fetcher) {
    super();
    this.id = 'verhdlink';
    this.label = 'VerHdLink';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.es, CountryCode.mx];
    this.baseUrl = 'https://verhdlink.cam';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const imdbId = await getImdbId(this.fetcher, ctx, id);

    const pageUrl = new URL(`/movie/${imdbId.id}`, this.baseUrl);
    const html = await this.fetcher.text(ctx, pageUrl);

    const $ = cheerio.load(html);

    return $('._player-mirrors')
      .map((_i, el) => {
        let countryCodes;
        if ($(el).hasClass('latino')) {
          countryCodes = [CountryCode.mx];
        } else if ($(el).hasClass('castellano')) {
          countryCodes = [CountryCode.es];
        } else {
          return [];
        }

        return $('[data-link!=""]', el)
          .map((_i, el) => new URL(($(el).attr('data-link')).replace(/^(https:)?\/\//, 'https://')))
          .toArray()
          .filter(url => !url.host.match(/verhdlink/))
          .map(url => ({ url, meta: { countryCodes, referer: this.baseUrl } }));
      }).toArray();
  }
}
