// src/extractor/Mixdrop.js
// Mixdrop extractor — works WITHOUT MediaFlowProxy
// Extracts direct mp4 URL from mixdrop.ag embed pages using unpacker

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { unpackEval, extractUrlFromPacked } from '../utils/embed.js';
import { Extractor } from './Extractor.js';

export class Mixdrop extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'mixdrop';
    this.label = 'Mixdrop';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/mixdrop|mixdrp|mixdroop|m1xdrop/);
  }

  normalize(url) {
    return new URL(url.href.replace('/f/', '/e/'));
  }

  async extractInternal(ctx, url, meta) {
    const fileUrl = new URL(url.href.replace('/e/', '/f/'));
    const html = await this.fetcher.text(ctx, fileUrl);

    if (/can't find the (file|video)/.test(html)) {
      return [];
    }

    const $ = cheerio.load(html);
    const title = $('.title b').text().trim() || $('title').text().trim();

    // Try unpacker approach (p.a.c.k.e.d)
    try {
      const playlistUrl = extractUrlFromPacked(html, [
        /sources:\[{file:"(.*?)"/,
        /file:"(https?:\/\/[^"]*\.mp4[^"]*)"/,
        /MDCore\.video_url\s*=\s*["']([^"']+)["']/,
      ]);

      return [{
        url: playlistUrl,
        format: Format.mp4,
        meta: { ...meta, title },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    } catch {
      // Fallback: try direct regex
    }

    // Fallback: look for direct mp4 URL in the page
    const mp4Match = html.match(/(https?:\/\/[^'"]*\.mp4[^'"]*)/i);
    if (mp4Match && mp4Match[1]) {
      return [{
        url: new URL(mp4Match[1]),
        format: Format.mp4,
        meta: { ...meta, title },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    return [];
  }
}
