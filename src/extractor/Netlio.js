// src/extractor/Netlio.js
// Netlio extractor — passthrough for direct HLS URLs from netlio.vercel.app.
//
// The Netlio source already resolves to direct HLS master playlist URLs
// (e.g., on hightechsecurity.shop, onlineartacademy.site, etc.) via the
// GitHub API. These URLs require a Referer header to play.
// No extraction step needed — just pass through with the Referer.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const NETLIO_CDN_PATTERNS = [
  '.hightechsecurity.shop',
  '.onlineartacademy.site',
  '.auroramedialimited.space',
  '.mindspireconsulting.sbs',
  '.skylineforge.space',
  '.auronetworkpartners.shop',
  '.fitnessfanatic.sbs',
  '.brightluneagency.cyou',
];

const REFERER = 'https://netlio.vercel.app/';

export class Netlio extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'netlio';
    this.label = 'Netlio';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url) {
    // Claim URLs from Netlio's CDN hosts
    return NETLIO_CDN_PATTERNS.some(suffix => url.hostname.endsWith(suffix));
  }

  async extractInternal(_ctx, url, meta) {
    return [{
      url,
      format: Format.hls,
      label: this.label,
      meta: { ...meta },
      requestHeaders: { Referer: REFERER },
    }];
  }
}
