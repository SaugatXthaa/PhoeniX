// src/extractor/Pantyflix.js
// Extractor for Pantyflix direct download streams.
//
// Pantyflix source returns direct playable MP4/MKV URLs from:
//   - cloud-dl.*.workers.dev (Bollyflix resolved via fastdlserver)
//   - dl.animeshrine.xyz (AnimeShrine)
//   - video-downloads.googleusercontent.com (GDrive CDN)
//   - bcdnxw.hakunaymatata.com (MovieBox)
//
// googleusercontent.com and bcdnxw.hakunaymatata.com work directly without
// proxy. Only animeshrine.xyz needs proxying (Connection reset by peer).
// Must come BEFORE Netlio to prevent Netlio from claiming *.workers.dev URLs.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// CDNs that fail with "Connection reset by peer" when fetched directly
const NEEDS_PROXY = /animeshrine|valentine|fukggl/;

export class Pantyflix extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'pantyflix';
    this.label = 'Pantyflix';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, _url, meta) {
    return meta?.sourceId === this.id;
  }

  async extractInternal(ctx, url, meta) {
    // Only proxy URLs that are known to fail with direct access.
    // googleusercontent.com, workers.dev, hakunaymatata.com work directly.
    if (NEEDS_PROXY.test(url.hostname)) {
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      return [{
        url: proxyUrl,
        format: Format.mp4,
        meta: { ...meta },
      }];
    }

    // Direct URL — works without proxy
    const isHls = url.pathname.includes('.m3u8') || url.pathname.includes('/hls/');
    return [{
      url,
      format: isHls ? Format.hls : Format.mp4,
      meta: { ...meta },
    }];
  }
}
