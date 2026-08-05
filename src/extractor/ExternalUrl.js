// src/extractor/ExternalUrl.js
// Ported from research/webstreamr-mbg/src/extractor/ExternalUrl.ts

import { Format } from '../types.js';
import { showExternalUrls } from '../utils/index.js';
import { Extractor } from './Extractor.js';

export class ExternalUrl extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'external';
    this.label = 'External';
    this.ttl = 21600000; // 6h
  }

  supports(ctx, url) {
    return showExternalUrls(ctx.config) && null !== url.host.match(/.*/);
  }

  async extractInternal(_ctx, url, meta) {
    return [
      {
        url: url,
        format: Format.unknown,
        isExternal: true,
        label: `${url.host}`,
        meta,
      },
    ];
  }
}
