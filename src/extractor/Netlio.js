// src/extractor/Netlio.js
// Netlio extractor — passthrough for direct HLS URLs from netlio.vercel.app.
//
// The Netlio source already resolves to direct HLS master playlist URLs
// (e.g., on hightechsecurity.shop, onlineartacademy.site, etc.) via the
// GitHub API. These URLs require a Referer header to play.
// No extraction step needed — just pass through with the Referer.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// Netlio uses dozens of rotating CDN domains. Instead of listing each one,
// we match by URL path pattern: all Netlio HLS URLs contain "cf-master"
// or "/v4/" in the path, and "/hls3/" for movie streams.
const isNetlioCdnUrl = (url) => {
  const path = url.pathname.toLowerCase();
  return path.includes('cf-master') ||
         path.includes('/v4/') ||
         path.includes('/hls3/') ||
         url.hostname.endsWith('.workers.dev');
};

const REFERER = 'https://netlio.vercel.app/';

export class Netlio extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'netlio';
    this.label = 'Netlio';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url) {
    return isNetlioCdnUrl(url);
  }

  async extractInternal(ctx, url, meta) {
    // Cloudflare-protected CDN (aurorionacademy.site, professionalidentity.cyou, etc.)
    // returns 403 to server-side requests. Route through /proxy which uses
    // got-scraping with HeaderGenerator for CF bypass.
    // The proxy also rewrites relative URLs in the m3u8 playlist.
    const proxyUrl = new URL('/proxy', ctx.hostUrl);
    proxyUrl.searchParams.set('url', url.href);
    proxyUrl.searchParams.set('referer', REFERER);

    return [{
      url: proxyUrl,
      format: Format.hls,
      label: this.label,
      meta: { ...meta },
    }];
  }
}
