// src/extractor/Pantyflix.js
// Extractor for Pantyflix direct download streams.
//
// Pantyflix source returns direct playable MP4/MKV URLs from:
//   - cloud-dl.*.workers.dev (Bollyflix resolved via fastdlserver)
//   - dl.animeshrine.xyz (AnimeShrine)
//   - bcdnxw.hakunaymatata.com (MovieBox)
//
// Some of these URLs get "Connection reset by peer" when Stremio's ffmpeg
// tries to fetch them directly. Routing through /proxy ensures the addon
// fetches the content and streams it back to Stremio reliably.
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

  async extractInternal(ctx, url, meta) {
    // Route through /proxy to avoid "Connection reset by peer" errors
    // when Stremio's ffmpeg player tries to fetch directly.
    // The proxy fetches the content server-side and streams it back.
    const proxyUrl = new URL('/proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', url.href);

    // Determine format from URL
    const isHls = url.pathname.includes('.m3u8') || url.pathname.includes('/hls/');
    return [{
      url: proxyUrl,
      format: isHls ? Format.hls : Format.mp4,
      meta: { ...meta },
    }];
  }
}
