// src/extractor/Cinejoy.js
// Extractor for Cinejoy (cinejoy.to) HLS streams.
//
// Cinejoy source returns HLS playlist URLs from help.earthcleaner.cc:
//   https://help.earthcleaner.cc/video/{id}/video_1080p.m3u8
//   https://help.earthcleaner.cc/playlist/{id}.m3u8
//
// These URLs require Referer: https://cinejoy.to/ to play.
// Route through /proxy with the Referer header.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const CINEJOY_HOSTS = ['help.earthcleaner.cc'];
const REFERER = 'https://cinejoy.to/';

export class Cinejoy extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'cinejoy';
    this.label = 'Cinejoy';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, url, meta) {
    // Only claim URLs from Cinejoy source
    return meta?.sourceId === this.id && CINEJOY_HOSTS.includes(url.hostname);
  }

  async extractInternal(ctx, url, meta) {
    // Route through /proxy with Referer so Stremio can play
    const proxyUrl = new URL('/proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', url.href);
    proxyUrl.searchParams.set('referer', REFERER);

    return [{
      url: proxyUrl,
      format: Format.hls,
      meta: { ...meta },
    }];
  }
}
