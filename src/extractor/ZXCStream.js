// src/extractor/ZXCStream.js
// Extractor for ZXCStream (zxcstream.xyz) direct stream URLs.
//
// ZXCStream source returns direct playable Cloudflare Worker / CDN URLs from
// 7 backend servers (1orion, 1icarus, 1berkas, 1resshin, 1daedalus, 1athena,
// 1sentinel). Most servers return URLs that play directly without proxy.
//
// Server-specific handling:
//   - 1berkas: Returns HLS master m3u8 with variant URLs on rotating
//     *.berkasNN.workers.dev subdomains. These subdomains are frequently
//     slow/dead (timeouts). Route through /proxy so the proxy can:
//       1. Fetch the master m3u8
//       2. Rewrite variant URLs to absolute /proxy URLs
//       3. Handle timeouts gracefully
//     Without proxy, Stremio gets the master m3u8 directly, tries to fetch
//     variants from slow subdomains, and gets stuck on loading.
//   - All other servers: Direct passthrough (no proxy needed).
//
// This extractor claims URLs where meta.sourceId === 'zxcstream' (set by the
// ZXCStream source). Without this, the Netlio extractor would claim *.workers.dev
// URLs and force them through /proxy with an incorrect Referer + HLS format,
// breaking MP4 streams.

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

  async extractInternal(ctx, url, meta) {
    // Berkas server: route through /proxy for m3u8 URL rewriting.
    // Berkas returns HLS master m3u8 with variant URLs on rotating
    // *.berkasNN.workers.dev subdomains that are frequently slow/dead.
    // The proxy fetches the master, rewrites variant URLs to /proxy URLs,
    // and handles timeouts gracefully.
    if (meta?.serverId === '1berkas') {
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);

      return [{
        url: proxyUrl,
        format: Format.hls,
        meta: { ...meta },
      }];
    }

    // All other servers: direct passthrough.
    // URLs are direct playable CDN URLs (workers.dev, devcorp.me).
    // They work without Referer/Auth — verified with Range requests (HTTP 206).
    return [{
      url,
      format: inferFormat(url),
      meta: { ...meta },
    }];
  }
}
