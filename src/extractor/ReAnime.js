// src/extractor/ReAnime.js
// Passthrough extractor for ReAnime /reanime-proxy URLs.
// These URLs are already direct playable HLS — the /reanime-proxy endpoint
// handles XOR decryption and segment rewriting internally.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class ReAnime extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'reanime';
    this.label = 'ReAnime';
    this.ttl = 300000; // 5min
  }

  supports(_ctx, url, meta) {
    // Claim URLs from ReAnime source (meta.sourceId === 'reanime')
    return meta?.sourceId === 'reanime';
  }

  async extractInternal(_ctx, url, meta) {
    return [{
      url,
      format: Format.hls,
      label: this.label,
      meta: { ...meta },
    }];
  }
}
