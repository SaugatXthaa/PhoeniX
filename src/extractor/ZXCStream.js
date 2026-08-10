// src/extractor/ZXCStream.js
// Passthrough extractor for ZXCStream (zxcstream.xyz) direct stream URLs.
//
// ZXCStream source returns direct playable Cloudflare Worker / CDN URLs from
// 7 backend servers (1orion, 1icarus, 1berkas, 1resshin, 1daedalus, 1athena,
// 1sentinel). These URLs are public (no Referer/Auth needed) and play directly.
//
// This extractor claims URLs where meta.sourceId === 'zxcstream' (set by the
// ZXCStream source). Without this, the Netlio extractor would claim *.workers.dev
// URLs and force them through /proxy with an incorrect Referer + HLS format,
// breaking MP4 streams.
//
// Format is inferred from the URL path:
//   - /hls/...          → HLS (Athena server)
//   - .m3u8             → HLS (Sentinel server)
//   - everything else   → MP4 (Icarus, Resshin, Daedalus, Orion MP4 links)

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

function inferFormat(url) {
  const path = url.pathname.toLowerCase();
  const href = url.href.toLowerCase();
  if (path.includes('/hls/') || path.endsWith('.m3u8') || href.includes('.m3u8')) {
    return Format.hls;
  }
  return Format.mp4;
}

export class ZXCStream extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'zxcstream';
    this.label = 'ZXCStream';
    this.ttl = 300000; // 5min — URLs are time-limited
  }

  supports(_ctx, _url, meta) {
    return meta?.sourceId === this.id;
  }

  async extractInternal(_ctx, url, meta) {
    // ZXCStream URLs are direct playable CDN URLs (workers.dev, devcorp.me).
    // They work without Referer/Auth — verified with Range requests (HTTP 206).
    // Return as-is to preserve the correct format and avoid proxy overhead.
    return [{
      url,
      format: inferFormat(url),
      meta: { ...meta },
    }];
  }
}
