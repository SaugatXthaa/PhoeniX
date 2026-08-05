// src/source/VidSrc.js
// Ported from research/webstreamr-mbg/src/source/VidSrc.ts

import { CountryCode } from '../types.js';
import { Source } from './Source.js';

export class VidSrc extends Source {
  constructor() {
    super();
    this.id = 'vidsrc';
    this.label = 'VidSrc';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://vidsrcme.ru';
  }

  async handleInternal(_ctx, _type, id) {
    const url = id.season
      ? new URL(`/embed/tv/${id.id}/${id.season}-${id.episode}`, this.baseUrl)
      : new URL(`/embed/movie/${id.id}`, this.baseUrl);

    return [{ url, meta: { countryCodes: [CountryCode.multi] } }];
  }
}
