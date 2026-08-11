// src/extractor/AnimeKai.js
// Extractor for AnimeKai (animekai.at → zokoanime.video) HLS streams.
// Same as HiAnime — routes through /proxy with Referer.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const REFERER = 'https://zokoanime.video/';

export class AnimeKai extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'animekai';
    this.label = 'AnimeKai';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, url, meta) {
    return meta?.sourceId === this.id;
  }

  async extractInternal(ctx, url, meta) {
    const proxyUrl = new URL('/proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', url.href);
    proxyUrl.searchParams.set('referer', REFERER);

    return [{
      url: proxyUrl,
      format: Format.hls,
      meta: { ...meta },
    }];
  }
}
