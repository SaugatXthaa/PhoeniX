// src/extractor/DoodStream.js
// DoodStream extractor — works WITHOUT MediaFlowProxy
// Extracts direct mp4 URL from doodstream embed pages

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class DoodStream extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'doodstream';
    this.label = 'DoodStream';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/dood|do[0-9]go|doood|dooood|ds2play|ds2video|dsvplay|d0o0d|do0od|d0000d|d000d|myvidplay|vidply|all3do|doply|vide0|vvide0|d-s/);
  }

  normalize(url) {
    const videoId = url.pathname.replace(/\/+$/, '').split('/').pop();
    return new URL(`https://dood.to/e/${videoId}`);
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    if (/Video not found/.test(html)) {
      return [];
    }

    // DoodStream uses /pass_md5/ endpoint to build the direct URL
    // The page contains a pass_md5 link
    const passMatch = html.match(/(\/pass_md5\/[^"'\s]+)/);
    if (passMatch && passMatch[1]) {
      const passUrl = new URL(passMatch[1], url.origin);
      const passResponse = await this.fetcher.text(ctx, passUrl, { headers });

      // Build the final URL: passResponse + some random string + file extension
      const randomString = Math.random().toString(36).substring(2, 12);
      const tokenMatch = html.match(/'([^']{10,})'\.substr/);
      const token = tokenMatch ? tokenMatch[1] : '';

      // The direct URL format: https://HOSTNAME/{passResponse}{randomString}.mp4?token={token}
      const directUrl = new URL(`${passResponse}${randomString}.mp4?token=${token}`, url.origin);
      
      return [{
        url: directUrl,
        format: Format.mp4,
        meta: { ...meta },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    // Fallback: look for direct mp4 URL
    const mp4Match = html.match(/(https?:\/\/[^'"]*\.mp4[^'"]*)/i);
    if (mp4Match && mp4Match[1]) {
      return [{
        url: new URL(mp4Match[1]),
        format: Format.mp4,
        meta: { ...meta },
        requestHeaders: { Referer: url.origin + '/' },
      }];
    }

    return [];
  }
}
