// src/extractor/HDGharTV.js
// Passthrough extractor for HDGharTV (hdghartv.cc) direct HLS streams.
//
// HDGharTV source returns direct playable HLS URLs from streamraiwind.stream
// CDN (e.g., cdn6.streamraiwind.stream, cdn100.streamraiwind.stream). These
// URLs have signed `token` + `expires` query params and play directly without
// Referer/Auth.
//
// This extractor claims URLs where meta.sourceId === 'hdghartv' (set by the
// HDGharTV source). Without this, the URL would be silently dropped by
// ExtractorRegistry (no other extractor matches streamraiwind.stream).
//
// All streams are HLS master playlists with multi-audio tracks (Hindi,
// English, Tamil, Telugu, etc.) as #EXT-X-MEDIA entries.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class HDGharTV extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'hdghartv';
    this.label = 'HDGharTV';
    this.ttl = 1800000; // 30min — URLs are time-limited (~1h)
  }

  supports(_ctx, _url, meta) {
    return meta?.sourceId === this.id;
  }

  async extractInternal(_ctx, url, meta) {
    // HDGharTV URLs are direct playable HLS — pass through as-is.
    // No Referer/Auth needed (verified with HTTP 200 + valid m3u8 content).
    return [{
      url,
      format: Format.hls,
      meta: { ...meta },
    }];
  }
}
