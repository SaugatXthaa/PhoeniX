// src/extractor/AnimeKai.js
// Extractor for AnimeKai (animekai.at → zokoanime.video) HLS streams.
//
// AnimeKai source returns HLS m3u8 URLs from aniwatchtv.uk:
//   https://hls2.aniwatchtv.uk/v/.../master.m3u8
//
// These URLs require Referer: https://zokoanime.video/ to play.
// Route through /proxy with the Referer header.
// Note: Same URL pattern as HiAnime — both use zokoanime.video backend.
// The meta.sourceId determines which extractor claims the URL.

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
