// src/extractor/AniPriv8.js
// Extractor for AniPriv8 (anipriv8.online) HLS streams.
//
// AniPriv8 source returns HLS playlist URLs like:
//   https://anipriv8.online/api/secure/pipeline/{token}
//
// These URLs return valid m3u8 content with RELATIVE segment URLs:
//   /api/secure/pipeline/{segmentToken}
//
// Two issues with direct playback:
//   1. Segments return Content-Type: image/png when Range header is sent
//      (Stremio always sends Range) — server bug. Without proxy, Stremio
//      refuses to play "image/png" as video.
//   2. Relative URLs need to be resolved against anipriv8.online, but
//      Stremio may try to resolve them against the addon's host.
//
// Fix: route through /proxy. The proxy fetches the m3u8, rewrites relative
// URLs to absolute /proxy URLs (so segments also go through the proxy),
// and serves the m3u8 with correct Content-Type. For segments, the proxy
// strips the Range header so the server returns the correct video/mp2t
// Content-Type.
//
// Actually the proxy already passes Range through. The server's behavior
// of returning image/png on Range requests is the bug. The proxy will
// fetch with Range and forward the response — but the body is valid
// MPEG-TS data regardless of Content-Type. The proxy overrides
// Content-Type to video/mp2t for these segments.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const ANIPRIV8_HOST = 'anipriv8.online';

export class AniPriv8 extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'anipriv8';
    this.label = 'AniPriv8';
    this.ttl = 300000; // 5min — tokens may expire
  }

  supports(_ctx, url, meta) {
    // Only claim URLs from AniPriv8 source (not other anipriv8.online URLs
    // that might come from different sources)
    return meta?.sourceId === 'anipriv8' && url.hostname === ANIPRIV8_HOST;
  }

  async extractInternal(ctx, url, meta) {
    // Route through /proxy — the proxy will:
    //   1. Fetch the m3u8 playlist
    //   2. Detect HLS content (starts with #EXTM3U)
    //   3. Rewrite relative segment URLs to absolute /proxy URLs
    //   4. Serve with correct Content-Type
    //
    // For segments: the proxy fetches them and streams the bytes through.
    // The server returns Content-Type: image/png for Range requests (bug),
    // but the body is valid MPEG-TS. The proxy forwards the body with
    // whatever Content-Type the server sends — Stremio's HLS player
    // ignores Content-Type for MPEG-TS segments (it detects by sync byte).
    const proxyUrl = new URL('/proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', url.href);

    return [{
      url: proxyUrl,
      format: Format.hls,
      meta: { ...meta },
    }];
  }
}
