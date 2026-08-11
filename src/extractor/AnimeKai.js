// src/extractor/AnimeKai.js
// Extractor for AnimeKai (animekai.at → zokoanime.video) HLS streams.
//
// Same as HiAnime — returns direct m3u8 URL with proxyHeaders (Referer).
// Avoids Render proxy timeouts.

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

  async extractInternal(_ctx, url, meta) {
    // Return direct URL — Stremio handles Referer via behaviorHints.proxyHeaders
    return [{
      url,
      format: Format.hls,
      requestHeaders: { Referer: REFERER },
      meta: { ...meta },
    }];
  }
}
