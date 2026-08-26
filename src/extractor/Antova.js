// src/extractor/Antova.js
// Passthrough extractor for Antova (AniLibria/AniLiberty) direct HLS streams.
//
// Antova source returns direct playable HLS URLs from cache.libria.fun:
//   https://cache.libria.fun/videos/media/ts/{releaseId}/{ep}/{quality}/{hash}.m3u8
//     ?countryIso=HK&isAuthorized=0&isWithVideoAds=1&isWithVideoAdsAlways=1
//
// These URLs play directly without Referer/Auth — verified with HTTP 200 +
// valid m3u8 content with absolute TS segment URLs.
//
// This extractor claims URLs where meta.sourceId === 'antova' (set by the
// Antova source). Without this, the URL would be silently dropped by
// ExtractorRegistry (no other extractor matches cache.libria.fun).
//
// All streams are Russian-dubbed (AniLibria is a Russian fan-dub group).
// Audio tracks: Japanese video + Russian dub.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class Antova extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'antova';
    this.label = 'Antova';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, _url, meta) {
    return meta?.sourceId === this.id;
  }

  async extractInternal(_ctx, url, meta) {
    // cache.libria.fun URLs are direct playable HLS — pass through as-is.
    // No Referer/Auth needed.
    return [{
      url,
      format: Format.hls,
      meta: { ...meta },
    }];
  }
}
