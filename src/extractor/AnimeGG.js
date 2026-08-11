// src/extractor/AnimeGG.js
// Extractor for AnimeGG (animegg.org) direct MP4 streams.
//
// AnimeGG source returns direct MP4 URLs from animegg.org:
//   https://www.animegg.org/play/{id}/video.mp4?for=...
//
// These URLs require Referer: https://www.animegg.org/ to play.
// Route through /proxy with the Referer header.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const REFERER = 'https://www.animegg.org/';

export class AnimeGG extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'animegg';
    this.label = 'AnimeGG';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, url, meta) {
    // Only claim URLs from AnimeGG source
    return meta?.sourceId === this.id && url.hostname.includes('animegg.org');
  }

  async extractInternal(ctx, url, meta) {
    // Route through /proxy with Referer so Stremio can play
    const proxyUrl = new URL('/proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', url.href);
    proxyUrl.searchParams.set('referer', REFERER);

    return [{
      url: proxyUrl,
      format: Format.mp4,
      meta: { ...meta },
    }];
  }
}
