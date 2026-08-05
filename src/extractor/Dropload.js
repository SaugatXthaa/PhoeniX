// src/extractor/Dropload.js
// Ported from research/webstreamr-mbg/src/extractor/Dropload.ts

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { NotFoundError } from '../error/index.js';
import { Format } from '../types.js';
import { extractUrlFromPacked, guessHeightFromPlaylist } from '../utils/index.js';
import { Extractor } from './Extractor.js';

export class Dropload extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'dropload';
    this.label = 'Dropload';
    this.ttl = 7200000; // 2h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/dropload|dr0pstream/);
  }

  normalize(url) {
    return new URL(url.href.replace('/d/', '/').replace('/e/', '/').replace('/embed-', '/'));
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    if (html.includes('File Not Found') || html.includes('Pending in queue')) {
      throw new NotFoundError();
    }

    const playlistUrl = extractUrlFromPacked(html, [/sources:\[{file:"(.*?)"/]);
    const playlistHeaders = { Referer: 'https://dr0pstream.com/' };

    const heightMatch = html.match(/\d{3,}x(\d{3,}),/);
    const height = heightMatch
      ? parseInt(heightMatch[1])
      : meta.height ?? await guessHeightFromPlaylist(ctx, this.fetcher, playlistUrl, { headers: playlistHeaders });

    const sizeMatch = html.match(/([\d.]+ ?[GM]B)/);
    const size = sizeMatch ? bytes.parse(sizeMatch[1]) : undefined;

    const $ = cheerio.load(html);
    const title = $('.videoplayer h1').text().trim();

    return [
      {
        url: playlistUrl,
        format: Format.hls,
        meta: {
          ...meta,
          title,
          ...(size && { bytes: size }),
          ...(height && { height }),
        },
        requestHeaders: playlistHeaders,
      },
    ];
  }
}
