// src/extractor/AnimeDirect.js
// Passthrough extractor for direct playable anime HLS/MP4 URLs.
//
// Anime sources (AniDB, AniNeko, HiAnime, AnimeFlix, NineAnime) return
// direct playable URLs from various CDN hosts. Without an extractor claiming
// these URLs, they're silently dropped by ExtractorRegistry.
//
// Hosts handled:
//   - hls.anidb.app (AniDB direct HLS)
//   - *.dramiyos-cdn.com, *.harborlane*, *.pinecliff* (AniNeko HLS)
//   - *.creativewritingtips.site, *.savannahridgedesignlab* (AniNeko/Netlio)
//   - gn1r5n.org, playmogo.com (HiAnime embed pages — need extraction)
//   - gogoanime.com.by (AnimeFlix/NineAnime embed pages — need extraction)
//
// For direct HLS URLs (anidb, anineko CDNs), we pass through with the
// appropriate Referer. For embed pages (hianime, gogoanime), we extract
// the actual stream URL from the page HTML.

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// Direct HLS CDN hosts (pass through as-is, just add Referer)
const DIRECT_HLS_HOSTS = [
  'hls.anidb.app',
];

// CDN host suffixes that serve direct HLS (AniNeko + Netlio CDNs)
const DIRECT_HLS_SUFFIXES = [
  '.dramiyos-cdn.com',
  '.harborlanecreativeworks.space',
  '.pinecliffdesigncollective.store',
  '.creativewritingtips.site',
  '.savannahridgedesignlab.cyou',
];

// Embed page hosts (need HTML extraction to find the actual stream URL)
const EMBED_HOSTS = [
  'gn1r5n.org',
  'playmogo.com',
  'gogoanime.com.by',
];

function isDirectHls(url) {
  if (DIRECT_HLS_HOSTS.includes(url.hostname)) return true;
  return DIRECT_HLS_SUFFIXES.some(suffix => url.hostname.endsWith(suffix));
}

function isEmbedPage(url) {
  return EMBED_HOSTS.includes(url.hostname);
}

// Check if URL has Netlio path patterns (cf-master, /v4/, /hls3/)
function isNetlioCdnUrl(url) {
  const path = url.pathname.toLowerCase();
  return path.includes('cf-master') ||
         path.includes('/v4/') ||
         path.includes('/hls3/');
}

export class AnimeDirect extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'animedirect';
    this.label = 'Anime';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url) {
    return isDirectHls(url) || isEmbedPage(url) || isNetlioCdnUrl(url);
  }

  async extractInternal(ctx, url, meta) {
    // Direct HLS — pass through with appropriate Referer
    if (isDirectHls(url)) {
      const referer = url.hostname === 'hls.anidb.app'
        ? 'https://anidb.app/'
        : 'https://anineko.to/';

      // Route through /proxy for CDN hosts that need Referer
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', referer);

      return [{
        url: proxyUrl,
        format: Format.hls,
        label: this.label,
        meta: { ...meta },
      }];
    }

    // Netlio CDN URLs — route through /proxy with Netlio Referer
    if (isNetlioCdnUrl(url)) {
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', 'https://netlio.vercel.app/');

      return [{
        url: proxyUrl,
        format: Format.hls,
        label: this.label,
        meta: { ...meta },
      }];
    }

    // Embed pages — extract the actual stream URL from HTML
    if (isEmbedPage(url)) {
      try {
        const html = await this.fetcher.text(ctx, url, {
          headers: { 'Referer': 'https://hianime.win/' },
          timeout: 10000,
        });

        // Look for HLS/MP4 URLs in the page
        const hlsMatch = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
        const mp4Match = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
        const sourceMatch = html.match(/source:\s*["']([^"']+)["']/i);
        const fileMatch = html.match(/file:\s*["']([^"']+)["']/i);

        const streamUrl = hlsMatch?.[0] || mp4Match?.[0] || sourceMatch?.[1] || fileMatch?.[1];

        if (streamUrl) {
          let parsed;
          try { parsed = new URL(streamUrl); } catch { return []; }

          // If the stream URL is itself an embed, try extracting from it too
          if (parsed.hostname.includes('gogoanime') || parsed.hostname.includes('streaming.php')) {
            // Try fetching the streaming page
            try {
              const streamHtml = await this.fetcher.text(ctx, parsed, {
                headers: { 'Referer': url.origin + '/' },
                timeout: 10000,
              });
              const hls2 = streamHtml.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
              const mp42 = streamHtml.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
              const source2 = streamHtml.match(/source:\s*["']([^"']+)["']/i);
              const file2 = streamHtml.match(/file:\s*["']([^"']+)["']/i);
              const innerUrl = hls2?.[0] || mp42?.[0] || source2?.[1] || file2?.[1];
              if (innerUrl) {
                try { parsed = new URL(innerUrl); } catch { return []; }
              } else {
                return [];
              }
            } catch { return []; }
          }

          const format = parsed.href.includes('.m3u8') ? Format.hls : Format.mp4;

          // Route through proxy if needed
          let finalUrl = parsed;
          if (parsed.hostname.endsWith('.workers.dev') ||
              parsed.hostname.includes('cloudflare')) {
            const proxyUrl = new URL('/proxy', ctx.hostUrl);
            proxyUrl.searchParams.set('url', parsed.href);
            proxyUrl.searchParams.set('referer', url.origin + '/');
            finalUrl = proxyUrl;
          }

          return [{
            url: finalUrl,
            format,
            label: this.label,
            meta: { ...meta },
          }];
        }

        // Look for packed eval JS (common in gogoanime players)
        const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?\)\)/s);
        if (evalMatch) {
          // Can't evaluate packed JS server-side — return the embed URL
          // through the proxy so Stremio can at least try
          return [];
        }
      } catch { /* extraction failed */ }
    }

    return [];
  }
}
