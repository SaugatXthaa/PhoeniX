// src/extractor/Vidsonic.js
// Ported from research/webstreamr-mbg/src/extractor/Vidsonic.ts

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { guessHeightFromPlaylist } from '../utils/index.js';
import { Extractor } from './Extractor.js';

function decodeHexUrl(hexString) {
  const joined = hexString.split('|').join('');
  let decoded = '';
  for (let i = 0; i < joined.length; i += 2) {
    decoded += String.fromCharCode(parseInt(joined.substring(i, i + 2), 16));
  }
  return decoded.split('').reverse().join('');
}

export class Vidsonic extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'vidsonic';
    this.label = 'Vidsonic';
    this.ttl = 43200000; // 12h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/vidsonic/);
  }

  async extractInternal(ctx, url, meta) {
    const html = await this.fetcher.text(ctx, url);

    const $ = cheerio.load(html);
    const title = $('title').text().trim().replace(/^Watch /, '').trim();

    const hexMatch = html.match(/const _0x1\s*=\s*'([^']+)'/);
    if (!hexMatch || !hexMatch[1]) {
      throw new Error('Could not find hex-encoded video URL in Vidsonic page');
    }

    const m3u8Url = new URL(decodeHexUrl(hexMatch[1]));
    const headers = { Origin: url.origin };

    const expiresParam = m3u8Url.searchParams.get('expires');
    const tokenTtl = Math.max(900000, Number(expiresParam) * 1000 - Date.now() - 120000);

    return [
      {
        url: m3u8Url,
        format: Format.hls,
        ttl: Math.min(tokenTtl, this.ttl),
        meta: {
          ...meta,
          height: meta.height ?? await guessHeightFromPlaylist(ctx, this.fetcher, m3u8Url, { headers }),
          title,
        },
        requestHeaders: headers,
      },
    ];
  }
}
