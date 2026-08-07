// src/extractor/CineSu.js
// CineSu extractor — direct m3u8 passthrough.
//
// The URL returned by CineSu source IS the master m3u8 playlist, so no
// extraction step is needed. We just mark it as HLS and pass through.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://cine.su/en/watch',
  Origin: 'https://cine.su',
};

export class CineSu extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'cinesu';
    this.label = 'CineSu';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url) {
    return url.host === 'cine.su' || url.host.endsWith('.cine.su');
  }

  async extractInternal(_ctx, url, meta) {
    return [{
      url,
      format: Format.hls,
      label: this.label,
      meta: { ...meta },
      requestHeaders: { Referer: HEADERS.Referer, Origin: HEADERS.Origin },
    }];
  }
}
