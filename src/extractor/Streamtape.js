// src/extractor/Streamtape.js
// Streamtape extractor — works WITHOUT MediaFlowProxy
// Extracts direct mp4 URL from streamtape embed pages

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class Streamtape extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'streamtape';
    this.label = 'Streamtape';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/streamtape|strtape|strcloud|stape|streamadblock|shavetape|tapeblocker|streamnoads|tapeadsenjoyer|watchadsontape/);
  }

  normalize(url) {
    return new URL(url.href.replace('/e/', '/v/'));
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    const $ = cheerio.load(html);
    const title = $('meta[name="og:title"]').attr('content') || $('title').text().trim();

    // Streamtape uses obfuscated JS to build the direct URL
    // Look for the link building pattern: document.getElementById('ideoo').innerHTML = ...
    // or: /get_video.php?id=...&sec=...
    
    // Pattern 1: data-link attribute
    const dataLink = $('#ideoo').attr('data-link') || $('.video-overlay').attr('data-link');
    if (dataLink) {
      const directUrl = new URL(dataLink, url.origin);
      return [{
        url: directUrl,
        format: Format.mp4,
        meta: { ...meta, title },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    // Pattern 2: get_video endpoint in JS
    const getVideoMatch = html.match(/\/get_video\.php\?[^"'\s]+/);
    if (getVideoMatch && getVideoMatch[0]) {
      const directUrl = new URL(getVideoMatch[0], url.origin);
      return [{
        url: directUrl,
        format: Format.mp4,
        meta: { ...meta, title },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    // Pattern 3: Look for direct mp4 URL
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
