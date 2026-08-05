// src/extractor/StreamEmbed.js
// Ported from research/webstreamr-mbg/src/extractor/StreamEmbed.ts

import { NotFoundError } from '../error/index.js';
import { Format } from '../types.js';
import { buildMediaFlowProxyHlsUrl, supportsMediaFlowProxy } from '../utils/index.js';
import { Extractor } from './Extractor.js';

export class StreamEmbed extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'streamembed';
    this.label = 'StreamEmbed';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/bullstream|mp4player|watch\.gxplayer/);
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    if (/Video is not ready/.test(html)) {
      throw new NotFoundError();
    }

    const videoMatch = html.match(/video ?= ?(.*);/);
    if (!videoMatch) throw new NotFoundError();
    const videoJson = videoMatch[1];
    const video = JSON.parse(videoJson);

    const m3u8Url = new URL(`/m3u8/${video.uid}/${video.md5}/master.txt?s=1&id=${video.id}&cache=${video.status}`, url.origin);

    const streamUrl = supportsMediaFlowProxy(ctx)
      ? buildMediaFlowProxyHlsUrl(ctx, m3u8Url, { Referer: url.origin }, true)
      : m3u8Url;

    return [
      {
        url: streamUrl,
        format: Format.hls,
        meta: {
          ...meta,
          height: (() => {
            try {
              if (!video.quality) return undefined;
              const qualities = JSON.parse(video.quality);
              const firstQuality = qualities[0];
              const height = parseInt(firstQuality);
              return height || undefined;
            } catch {
              return undefined;
            }
          })(),
          title: decodeURIComponent(video.title),
        },
      },
    ];
  }
}
