// src/extractor/AcerMovies.js
// AcerMovies extractor — routes GDrive CDN URLs through /range-proxy.
//
// The AcerMovies source resolves to a direct
// video-downloads.googleusercontent.com URL via the acermovies.fun API.
//
// IMPORTANT: Google's video-downloads.googleusercontent.com does NOT support
// HTTP Range requests — it returns HTTP 200 with the FULL file regardless of
// any Range header. This breaks video seeking in Stremio (the player needs
// 206 Partial Content + Content-Range to scrub to a specific timestamp).
//
// We route these URLs through /range-proxy which does Range translation:
//   1. Fetches the full file from Google (stream)
//   2. Slices the requested byte range
//   3. Returns 206 + Content-Range + Accept-Ranges so Stremio can seek
//
// Only matches video-downloads.googleusercontent.com URLs. Other googleusercontent
// subdomains (lh3, drive.usercontent) are handled by DirectStream.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class AcerMovies extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'acermovies';
    this.label = 'AcerMovies';
    this.ttl = 300000; // 5min — GDrive URLs have time-limited tokens that expire
  }

  supports(_ctx, url) {
    // Only claim video-downloads.googleusercontent.com URLs (AcerMovies'
    // direct GDrive CDN). Other googleusercontent subdomains are left to
    // their respective extractors (HubExtractor, DirectStream, etc.).
    return url.hostname === 'video-downloads.googleusercontent.com';
  }

  async extractInternal(ctx, url, meta) {
    // Route through /range-proxy for Range translation.
    // Google's video-downloads.googleusercontent.com ignores Range headers
    // and returns the full file with HTTP 200 — /range-proxy translates this
    // to proper 206 Partial Content responses so Stremio can seek.
    const proxyUrl = new URL('/range-proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', url.href);
    return [{
      url: proxyUrl,
      format: Format.mp4,
      label: this.label,
      meta: { ...meta },
    }];
  }
}
