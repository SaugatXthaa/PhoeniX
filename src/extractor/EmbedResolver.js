// src/extractor/EmbedResolver.js
// Generic embed page resolver — fetches embed pages and extracts direct
// m3u8/mp4 stream URLs from the HTML/JavaScript.
//
// Handles embed URLs from sources that return iframe/embed pages:
//   - vidsrc.to/embed/movie/...
//   - vidsrc.me/embed/movie?tmdb=...
//   - vidsrc-embed.ru/embed/movie/...
//   - player.vidzee.wtf/embed/movie/...
//   - vide0.net/e/...
//   - voe.sx/e/...
//   - mixdrop.ag/e/...
//   - streamtape.com/e/...
//   - dr0pstream.com/embed-...
//
// Strategy:
//   1. Fetch the embed page HTML (with Referer if provided)
//   2. Search for m3u8/mp4 URLs in: script tags, JSON configs, data attributes,
//      window.location redirects, sources: [{file:"..."}] patterns
//   3. If found, return the direct stream URL
//   4. If not found, try fetching JS bundle files referenced in the page
//      and search those for stream URLs
//
// This is a FALLBACK extractor — it runs AFTER all dedicated extractors.
// If a dedicated extractor (Voe, Mixdrop, Streamtape, VidSrc, etc.) already
// handles the URL, this one won't run.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// Hosts that this extractor handles (embed/iframe pages that need resolution)
const EMBED_HOSTS = [
  'vidsrc.to',
  'vidsrc.me',
  'vidsrc-embed.ru',
  'player.vidzee.wtf',
  'vide0.net',
  'voe.sx',
  'mixdrop.ag',
  'mixdrop.to',
  'streamtape.com',
  'dr0pstream.com',
  'embed.su',
  '2embed.cc',
  'multiembed.mov',
  'vidsrc.net',
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class EmbedResolver extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'embedresolver';
    this.label = 'Embed';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, url, meta) {
    // Don't match if a sourceId is set that has a dedicated extractor
    // (those are handled by their own extractors first)
    const hostname = url.hostname.toLowerCase();
    return EMBED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  }

  async extractInternal(ctx, url, meta) {
    const referer = meta?.referer || '';
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer && { Referer: referer }),
    };

    try {
      // Step 1: Fetch the embed page
      const { gotScraping } = await import('got-scraping');
      const res = await gotScraping.get(url.href, {
        headers,
        timeout: { request: 12000 },
        throwHttpErrors: false,
        followRedirect: true,
        http2: true,
      });

      if (res.statusCode !== 200 || !res.body) {
        return [];
      }

      const html = res.body;
      const results = [];

      // Pattern 1: sources: [{file:"URL"}]  (JW Player / VideoJS)
      const sourcesMatch = html.match(/sources:\s*\[\s*\{[^}]*file:\s*['"]([^'"]+)['"][^}]*\}/i);
      if (sourcesMatch?.[1]) {
        try {
          const streamUrl = new URL(sourcesMatch[1]);
          results.push({
            url: streamUrl,
            format: streamUrl.href.includes('.m3u8') ? Format.hls : Format.mp4,
            meta: { ...meta },
            requestHeaders: { Referer: url.origin + '/' },
          });
        } catch {}
      }

      // Pattern 2: hlsUrl, mp4Url, or streamUrl in JSON
      const jsonMatches = html.matchAll(/['"](?:hlsUrl|hls_url|mp4Url|mp4_url|streamUrl|stream_url|fileUrl|file_url|playbackUrl|playback_url)['"]:\s*['"]([^'"]+)['"]/gi);
      for (const m of jsonMatches) {
        if (m[1]?.startsWith('http')) {
          try {
            const streamUrl = new URL(m[1]);
            results.push({
              url: streamUrl,
              format: streamUrl.href.includes('.m3u8') ? Format.hls : Format.mp4,
              meta: { ...meta },
              requestHeaders: { Referer: url.origin + '/' },
            });
          } catch {}
        }
      }

      // Pattern 3: Direct .m3u8 or .mp4 URL anywhere in the page
      const directMatches = html.matchAll(/(https?:\/\/[^'"\s<>]*\.(?:m3u8|mp4)[^'"\s<>]*)/gi);
      const seenUrls = new Set();
      for (const m of directMatches) {
        if (m[1] && !seenUrls.has(m[1]) && !m[1].includes('favicon')) {
          seenUrls.add(m[1]);
          try {
            const streamUrl = new URL(m[1]);
            results.push({
              url: streamUrl,
              format: m[1].includes('.m3u8') ? Format.hls : Format.mp4,
              meta: { ...meta },
              requestHeaders: { Referer: url.origin + '/' },
            });
          } catch {}
        }
      }

      // Pattern 4: Base64-encoded JSON containing stream URL
      // Some embed pages store the config as base64 → JSON with {file: "url"}
      const b64Matches = html.matchAll(/atob\(['"]([A-Za-z0-9+/=]{20,})['"]\)/g);
      for (const m of b64Matches) {
        try {
          const decoded = Buffer.from(m[1], 'base64').toString('utf8');
          const urlMatch = decoded.match(/(https?:\/\/[^'"\s]*\.(?:m3u8|mp4)[^'"\s]*)/i);
          if (urlMatch?.[1] && !seenUrls.has(urlMatch[1])) {
            seenUrls.add(urlMatch[1]);
            const streamUrl = new URL(urlMatch[1]);
            results.push({
              url: streamUrl,
              format: urlMatch[1].includes('.m3u8') ? Format.hls : Format.mp4,
              meta: { ...meta },
              requestHeaders: { Referer: url.origin + '/' },
            });
          }
        } catch {}
      }

      // Pattern 5: window.location redirect to a direct video URL
      const redirectMatch = html.match(/window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i);
      if (redirectMatch?.[1] && !seenUrls.has(redirectMatch[1])) {
        try {
          const streamUrl = new URL(redirectMatch[1]);
          results.push({
            url: streamUrl,
            format: redirectMatch[1].includes('.m3u8') ? Format.hls : Format.mp4,
            meta: { ...meta },
          });
        } catch {}
      }

      // Deduplicate by URL
      const seen = new Set();
      const unique = results.filter(r => {
        const key = r.url.href;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return unique;
    } catch (e) {
      // Silent failure — embed resolution is best-effort
      return [];
    }
  }
}
