// src/extractor/LuluStream.js
// LuluStream extractor — works WITHOUT MediaFlowProxy
// Extracts direct m3u8 URL from lulustream.com embed pages using unpacker

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { extractUrlFromPacked } from '../utils/embed.js';
import { Extractor } from './Extractor.js';

export class LuluStream extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'lulustream';
    this.label = 'LuluStream';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/lulu/) || ['streamhihi.com', 'cdn1.site', 'd00ds.site'].includes(url.host);
  }

  normalize(url) {
    const videoId = url.pathname.replace(/\/+$/, '').split('/').pop();
    return new URL(`/e/${videoId}`, url);
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const fileUrl = new URL(url.href.replace('/e/', '/d/'));
    const html = await this.fetcher.text(ctx, fileUrl, { headers });

    if (/No such file|File Not Found/.test(html)) {
      return [];
    }

    const $ = cheerio.load(html);
    const title = $('h1').text().trim() || $('title').text().trim();

    try {
      const playlistUrl = extractUrlFromPacked(html, [
        /sources:\[{file:"(.*?)"/,
        /file:"(https?:\/\/[^"]*\.m3u8[^"]*)"/,
      ]);

      return [{
        url: playlistUrl,
        format: Format.hls,
        meta: { ...meta, title },
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
        meta: { ...meta, title },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    return [];
  }
}
