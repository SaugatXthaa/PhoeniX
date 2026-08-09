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

  supports(ctx, url, meta) {
    // Claim known HDHub4u CDN hosts (non-workers.dev)
    if (url.hostname === 'cdn.fukggl.buzz' ||
        url.hostname === 'cdn.fsl-buckets.work' ||
        url.hostname.includes('hubcloud-download')) {
      return true;
    }
    // For workers.dev hosts — only claim if this URL came from the
    // HDHub4uNew source (identified by meta.hdhub4unewOriginalUrl or
    // meta.sourceId === 'hdhub4unew'). Other sources may also use
    // workers.dev (e.g. AniDoor's nightslayer.workers.dev) and would
    // be wrongly claimed here.
    if (url.hostname.endsWith('.workers.dev')) {
      return meta?.hdhub4unewOriginalUrl || meta?.sourceId === 'hdhub4unew';
    }
    return false;
  }

  async extractInternal(ctx, url, meta) {
    // Re-resolve via Sootio to get a FRESH CDN URL (cached URLs get
    // rate-limited after a few requests). Then route through /proxy
    // with Sootio Referer so the CDN returns 206 (seekable).
    let cdnUrl = url;

    // If this is a workers.dev URL from a previous Sootio resolution,
    // re-resolve the original hubdrive.tips URL via Sootio for a fresh CDN URL.
    // The original hubdrive URL is stored in meta by the source.
    if (meta?.hdhub4unewOriginalUrl) {
      try {
        const { gotScraping } = await import('got-scraping');
        const sootioUrl = `https://sootio.forthewizards.uk/resolve/httpstreaming/${encodeURIComponent(meta.hdhub4unewOriginalUrl)}`;
        const res = await gotScraping.get(sootioUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: { request: 10000 },
          throwHttpErrors: false,
          followRedirect: false,
        });
        if (res.statusCode === 302 && res.headers.location) {
          cdnUrl = new URL(res.headers.location);
        }
      } catch { /* re-resolve failed — use cached URL */ }
    }

    const proxyUrl = new URL('/proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', cdnUrl.href);
    proxyUrl.searchParams.set('referer', 'https://sootio.forthewizards.uk/');

    return [{
      url: proxyUrl,
      format: Format.mp4,
      label: this.label,
      meta: { ...meta },
    }];
  }
}
