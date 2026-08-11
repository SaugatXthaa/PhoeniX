// src/extractor/HiAnime.js
// Extractor for HiAnime (hianime.at) HLS streams.
//
// HiAnime source returns HLS m3u8 URLs from aniwatchtv.uk:
//   https://hls2.aniwatchtv.uk/v/.../master.m3u8
//
// These URLs require Referer: https://zokoanime.video/ to play.
// The m3u8 has relative segment URLs which resolve against the m3u8's URL.
//
// We return the DIRECT m3u8 URL with proxyHeaders (Referer) instead of
// routing through /proxy. This avoids Render proxy timeouts — Stremio's
// internal player sends the Referer header natively.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const REFERER = 'https://zokoanime.video/';

export class HiAnime extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'hianime';
    this.label = 'HiAnime';
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
