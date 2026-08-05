// src/extractor/Voe.js
// Voe extractor — works WITHOUT MediaFlowProxy
// Extracts direct m3u8/mp4 URL from voe.sx embed pages

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const VOE_DOMAINS = [
  'voe.sx', 'voe-unblock.com', 'voe-unblock1.com', 'voe-unblock2.com',
  'voe-unblock3.com', 'voe-unblock4.com', 'voe-unblock5.com',
  'jilliandescribecompany.com', 'charlestoughrace.com',
  'mikaylaarealike.com', 'lancewhosedifficult.com',
  'kathleenmemberhistory.com', 'erikcoldperson.com',
  'christopheruntilpoint.com', 'launchreliantcleaverriver.com',
  '19turanosephantasia.com', 'housecardsummerbutton.com',
  'guidon40hyporadius9.com', 'gamoneinterrupted.com',
  'ruralhoots.com', 'fapfap.apache.de',
];

export class Voe extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'voe';
    this.label = 'VOE';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return VOE_DOMAINS.some(d => url.host.includes(d)) || null !== url.host.match(/voe/);
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    // Try to find m3u8 URL in the page source
    // Pattern 1: sources: [{file:"URL"}]
    const sourcesMatch = html.match(/sources:\s*\[\s*\{[^}]*file:\s*['"]([^'"]+)['"][^}]*\}/i);
    if (sourcesMatch && sourcesMatch[1]) {
      const streamUrl = new URL(sourcesMatch[1]);
      return [{
        url: streamUrl,
        format: streamUrl.href.includes('.m3u8') ? Format.hls : Format.mp4,
        meta: { ...meta },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    // Pattern 2: hlsUrl or mp4Url in JS
    const hlsMatch = html.match(/['"]hls['"]:\s*['"]([^'"]+)['"]/i);
    if (hlsMatch && hlsMatch[1]) {
      return [{
        url: new URL(hlsMatch[1]),
        format: Format.hls,
        meta: { ...meta },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    // Pattern 3: Direct .m3u8 or .mp4 URL in the page
    const directMatch = html.match(/(https?:\/\/[^'"]*\.(?:m3u8|mp4)[^'"]*)/i);
    if (directMatch && directMatch[1]) {
      return [{
        url: new URL(directMatch[1]),
        format: directMatch[1].includes('.m3u8') ? Format.hls : Format.mp4,
        meta: { ...meta },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    // Pattern 4: Find in script tags — Voe uses obfuscated JS
    // Look for base64-encoded URLs or JSON with video sources
    const $ = cheerio.load(html);
    const title = $('title').text().trim();

    // Pattern 5: window.location redirect to a direct video URL
    const redirectMatch = html.match(/window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i);
    if (redirectMatch && redirectMatch[1]) {
      return [{
        url: new URL(redirectMatch[1]),
        format: redirectMatch[1].includes('.m3u8') ? Format.hls : Format.mp4,
        meta: { ...meta, title },
      }];
    }

    return [];
  }
}
