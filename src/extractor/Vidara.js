// src/extractor/Vidara.js
// Ported from research/webstreamr-mbg/src/extractor/Vidara.ts

import { Format } from '../types.js';
import { guessHeightFromPlaylist } from '../utils/index.js';
import { Extractor } from './Extractor.js';

export class Vidara extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'vidara';
    this.label = 'Vidara';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/vidara/);
  }

  async extractInternal(ctx, url, meta) {
    const filecode = url.pathname.split('/').filter(Boolean).pop();

    if (!filecode) {
      throw new Error('Could not extract filecode from Vidara URL');
    }

    const apiUrl = new URL('/api/stream', url.origin);
    const responseBody = await this.fetcher.textPost(
      ctx,
      apiUrl,
      JSON.stringify({ filecode, device: 'web' }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    const data = JSON.parse(responseBody);

    if (!data.streaming_url) {
      throw new Error('No streaming_url in Vidara API response');
    }

    const m3u8Url = new URL(data.streaming_url);
    const headers = { Origin: url.origin };

    return [
      {
        url: m3u8Url,
        format: Format.hls,
        meta: {
          ...meta,
          height: meta.height ?? await guessHeightFromPlaylist(ctx, this.fetcher, m3u8Url, { headers }),
          title: data.title,
        },
        requestHeaders: headers,
      },
    ];
  }
}
