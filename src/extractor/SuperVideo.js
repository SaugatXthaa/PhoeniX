// src/extractor/SuperVideo.js
// Ported from research/webstreamr-mbg/src/extractor/SuperVideo.ts

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { NotFoundError } from '../error/index.js';
import { Format } from '../types.js';
import { extractUrlFromPacked, guessHeightFromPlaylist } from '../utils/index.js';
import { Extractor } from './Extractor.js';

export class SuperVideo extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'supervideo';
    this.label = 'SuperVideo';
    this.ttl = 10800000; // 3h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/supervideo/);
  }

  normalize(url) {
    return new URL(url.href.replace('/e/', '/').replace('/k/', '/').replace('/embed-', '/'));
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    if (html.includes('This video can be watched as embed only')) {
      return await this.extractInternal(ctx, new URL(`/e${url.pathname}`, url.origin), meta);
    }

    if (/The file was deleted|The file expired|Video is processing/.test(html)) {
      throw new NotFoundError();
    }

    const playlistUrl = extractUrlFromPacked(html, [/sources:\[{file:"(.*?)"/]);
    const playlistHeaders = { Referer: 'https://supervideo.cc/' };

    const heightAndSizeMatch = html.match(/\d{3,}x(\d{3,}), ([\d.]+ ?[GM]B)/);
    const size = heightAndSizeMatch ? bytes.parse(heightAndSizeMatch[2]) : undefined;
    const height = heightAndSizeMatch
      ? parseInt(heightAndSizeMatch[1])
      : meta.height ?? await guessHeightFromPlaylist(ctx, this.fetcher, playlistUrl, { headers: playlistHeaders });

    const $ = cheerio.load(html);
    const title = $('.download__title').text().trim();

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
