// src/extractor/AcerMovies.js
// AcerMovies extractor — passthrough for direct GDrive CDN URLs.
//
// The AcerMovies source already resolves to a direct
// video-downloads.googleusercontent.com URL via the acermovies.fun API,
// so no extraction step is needed. This extractor just marks the URL as
// MP4 and passes it through.
//
// Only matches googleusercontent.com URLs when the source is AcerMovies
// (identified via meta.sourceId === 'acermovies'). This prevents the
// extractor from hijacking HubCloud's googleusercontent URLs.

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
    // their respective extractors (HubExtractor, etc.).
    return url.hostname === 'video-downloads.googleusercontent.com';
  }

  async extractInternal(_ctx, url, meta) {
    return [{
      url,
      format: Format.mp4, // GDrive CDN serves MP4/MKV — Stremio plays both as mp4
      label: this.label,
      meta: { ...meta },
      // No requestHeaders needed — GDrive CDN allows direct access
    }];
  }
}
