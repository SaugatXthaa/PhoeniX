// src/extractor/HDHub4uNew.js
// HDHub4uNew extractor — passthrough for Sootio-resolved CDN URLs.
//
// The HDHub4uNew source resolves hubdrive.tips URLs via Sootio, which
// returns a 302 redirect to a direct CDN URL (e.g., on
// hubcloud-download.*.workers.dev or cdn.fukggl.buzz). These URLs are
// already direct playable MP4/MKV files — no extraction step needed.
//
// This extractor claims URLs from the HDHub4uNew source (identified via
// meta.sourceId === 'hdhub4unew') and passes them through as MP4.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class HDHub4uNew extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'hdhub4unew';
    this.label = 'HDHub4uNew';
    this.ttl = 300000; // 5min — CDN URLs may expire
  }

  supports(_ctx, url) {
    // Claim URLs from workers.dev hosts (Sootio resolver output)
    // and cdn.fukggl.buzz (another common HDHub4u CDN)
    // Must match BEFORE HubExtractor (which matches 'hubcloud' in hostname)
    // — we're registered after HubExtractor, so we only get URLs it doesn't
    // claim. But hubcloud-download.*.workers.dev contains 'hubcloud' so
    // HubExtractor claims it first. We need to claim it here instead.
    // Fix: claim any URL with 'hubcloud-download' in the hostname
    return url.hostname.endsWith('.workers.dev') ||
           url.hostname === 'cdn.fukggl.buzz' ||
           url.hostname === 'cdn.fsl-buckets.work' ||
           url.hostname.includes('hubcloud-download');
  }

  async extractInternal(_ctx, url, meta) {
    return [{
      url,
      format: Format.mp4, // CDN serves MP4/MKV directly
      label: this.label,
      meta: { ...meta },
    }];
  }
}
