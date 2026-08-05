// src/extractor/FileMoon.js
// FileMoon extractor — works WITHOUT MediaFlowProxy
// Extracts direct m3u8 URL from filemoon embed pages using unpacker

import { Format } from '../types.js';
import { extractUrlFromPacked } from '../utils/embed.js';
import { Extractor } from './Extractor.js';

export class FileMoon extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'filemoon';
    this.label = 'FileMoon';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/filemoon/) ||
      ['furher.in', 'moonmov.pro', 'cinegrab.com'].includes(url.host);
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    try {
      const playlistUrl = extractUrlFromPacked(html, [
        /sources:\[{file:"(.*?)"/,
        /file:"(https?:\/\/[^"]*\.m3u8[^"]*)"/,
      ]);

      return [{
        url: playlistUrl,
        format: Format.hls,
        meta: { ...meta },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    } catch {
      // Fallback: try direct URL
    }

    // Fallback: look for direct m3u8/mp4 URL
    const directMatch = html.match(/(https?:\/\/[^'"]*\.(?:m3u8|mp4)[^'"]*)/i);
    if (directMatch && directMatch[1]) {
      return [{
        url: new URL(directMatch[1]),
        format: directMatch[1].includes('.m3u8') ? Format.hls : Format.mp4,
        meta: { ...meta },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    return [];
  }
}
