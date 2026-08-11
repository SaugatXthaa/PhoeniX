// src/extractor/Peckle.js
// Extractor for 2Peckle (ShowBox/FebBox) direct stream URLs.
//
// 2Peckle source returns URLs from shegu.net:
//   - ORG: https://usa7-as05.shegu.net/vip/.../movie.mkv?KEY1=... (direct MKV)
//   - HLS: https://hls.shegu.net/{id}.m3u8?sign=...&t=... (transcoded HLS)
//
// These URLs play directly without Referer/Auth — verified with HTTP 200/206.
// Must come before ExternalUrl to prevent silent drops.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class Peckle extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'peckle';
    this.label = '2Peckle';
    this.ttl = 600000; // 10min — stream URLs have time-limited signatures
  }

  supports(_ctx, url, meta) {
    // Only claim URLs from 2Peckle source
    return meta?.sourceId === this.id;
  }

  async extractInternal(_ctx, url, meta) {
    // shegu.net URLs play directly — pass through as-is.
    // No Referer/Auth needed (verified with HTTP 200/206).
    const isMkv = url.pathname.includes('.mkv') || url.pathname.includes('.mp4');
    return [{
      url,
      format: isMkv ? Format.mp4 : Format.hls,
      meta: { ...meta },
    }];
  }
}
