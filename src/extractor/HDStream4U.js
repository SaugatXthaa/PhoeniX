// src/extractor/HDStream4U.js
// Ported from research/webstreamr-mbg/src/extractor/HDStream4U.ts

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class HDStream4U extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'hdstream4u';
    this.label = 'HDStream4U';
    this.ttl = 300000; // 5 min
  }

  supports(_ctx, url) {
    return url.host.includes('hdstream4u.com');
  }

  normalize(url) {
    // Convert /file/ URLs to /embed/ URLs for extraction
    const code = url.pathname.replace(/\/+$/, '').split('/').at(-1);
    return new URL(`https://hdstream4u.com/embed/${code}`);
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    let html;
    try {
      html = await this.fetcher.text(ctx, url, { headers });
    } catch (error) {
      this.logger.warn(`Failed to fetch HDStream4U embed page: ${error}`);
      return [];
    }

    const m3u8Url = this.extractM3u8Url(html);

    if (m3u8Url) {
      return [
        {
          url: m3u8Url,
          format: Format.hls,
          meta,
          requestHeaders: { Referer: 'https://hdstream4u.com/' },
        },
      ];
    }

    // Fallback: try the download page for a direct MP4 link
    const code = url.pathname.replace(/\/+$/, '').split('/').at(-1);
    const downloadUrl = new URL(`https://hdstream4u.com/download/${code}`);

    try {
      const downloadHtml = await this.fetcher.text(ctx, downloadUrl, { headers });
      const mp4Url = this.extractDirectUrl(downloadHtml);

      if (mp4Url) {
        return [
          {
            url: mp4Url,
            format: Format.mp4,
            meta,
            requestHeaders: { Referer: 'https://hdstream4u.com/' },
          },
        ];
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch HDStream4U download page: ${error}`);
    }

    return [];
  }

  extractM3u8Url(html) {
    // Pattern 1: JWPlayer sources with file property containing m3u8
    const jwSourceMatch = html.match(/file\s*:\s*["']([^"']*\.m3u8[^"']*)["']/);
    if (jwSourceMatch?.[1]) {
      try {
        return new URL(jwSourceMatch[1]);
      } catch {
        // URL parsing failed, try next pattern
      }
    }

    // Pattern 2: Any URL containing master.m3u8
    const masterMatch = html.match(/(https?:\/\/[^\s"'<>]+master\.m3u8[^\s"'<>]*)/);
    if (masterMatch?.[1]) {
      try {
        return new URL(masterMatch[1]);
      } catch {
        // URL parsing failed, try next pattern
      }
    }

    // Pattern 3: Any URL ending in .m3u8 (possibly with query params)
    const m3u8Match = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/);
    if (m3u8Match?.[1]) {
      try {
        return new URL(m3u8Match[1]);
      } catch {
        // URL parsing failed
      }
    }

    return null;
  }

  extractDirectUrl(html) {
    const directMatch = html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|avi)[^\s"'<>]*)/i);
    if (directMatch?.[1]) {
      try {
        return new URL(directMatch[1]);
      } catch {
        // URL parsing failed
      }
    }

    const downloadLinkMatch = html.match(/href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>\s*(?:Download|Direct|Click)/i);
    if (downloadLinkMatch?.[1]) {
      try {
        return new URL(downloadLinkMatch[1]);
      } catch {
        // URL parsing failed
      }
    }

    return null;
  }
}
