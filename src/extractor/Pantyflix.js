// src/extractor/Pantyflix.js
// Extractor for Pantyflix direct download streams.
//
// Pantyflix source returns direct playable MP4/MKV URLs from:
//   - cloud-dl.*.workers.dev (Bollyflix resolved via fastdlserver)
//   - dl.animeshrine.xyz (AnimeShrine)
//   - bcdnxw.hakunaymatata.com (MovieBox)
//
// These URLs play directly without Referer/Auth — verified with Range requests.
// Must come BEFORE Netlio to prevent Netlio from claiming *.workers.dev URLs.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class Pantyflix extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'pantyflix';
    this.label = 'Pantyflix';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, _url, meta) {
    // Only claim URLs from Pantyflix source
    return meta?.sourceId === this.id;
  }

  async extractInternal(_ctx, url, meta) {
    // Pantyflix URLs are direct playable CDN URLs — pass through as-is.
    // No Referer/Auth needed (verified with HTTP 206 + valid MKV/MP4 data).
    return [{
      url,
      format: Format.mp4,
      meta: { ...meta },
    }];
  }
}
