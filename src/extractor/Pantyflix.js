// src/extractor/Pantyflix.js
// Extractor for Pantyflix + BollyFlix direct download streams.
//
// Both sources return dl.fastdlserver.site URLs that need to be resolved.
// The current resolution chain (Aug 2026):
//   1. fastdlserver.site/?id={base64} → 302 redirect → gdflix.dev/file/{id}
//   2. gdflix.dev/file/{id} HTML page contains 'Instant DL' button →
//      instant.busycdn.xyz/{hash}::{hash}?bytes={size}
//   3. busycdn URL → 302 redirect → fastdl-one.pages.dev/?url={googleusercontent_url}
//   4. The 'url' query param is the direct playable googleusercontent.com URL
//      (returns video/mkv with Content-Length — confirmed playable in Stremio)
//
// Older /cflare/ endpoint now requires Cloudflare Turnstile challenge —
// the /file/ endpoint bypasses it because the busycdn URL is in the HTML
// directly (no JS challenge needed).
//
// googleusercontent.com, workers.dev, hakunaymatata.com work directly without
// resolution. Only fastdlserver.site URLs need the redirect chain resolution.
//
// Must come BEFORE Netlio to prevent Netlio from claiming *.workers.dev URLs.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// CDNs that fail with "Connection reset by peer" when fetched directly
const NEEDS_PROXY = /animeshrine|valentine|fukggl/;

// Cache for resolved fastdlserver URLs (avoids re-resolving on every request)
const _resolveCache = new Map();
const RESOLVE_CACHE_TTL = 5 * 60 * 1000; // 5min

// Cache got-scraping module
let _gotScraping = null;
async function getGotScraping() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[pantyflix] Failed to load got-scraping:', e.message);
  }
  return _gotScraping;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Resolve fastdlserver URL to direct playable googleusercontent URL.
// Chain: fastdlserver → gdflix /file/{id} → busycdn URL → 302 → fastdl-one.pages.dev/?url={googleusercontent}
async function resolveFastDlServer(url) {
  // Check cache first
  const cached = _resolveCache.get(url.href);
  if (cached && Date.now() - cached.ts < RESOLVE_CACHE_TTL) {
    return cached.url;
  }

  const gotScraping = await getGotScraping();
  if (!gotScraping) return null;

  try {
    // Step 1: Follow fastdlserver → gdflix /file/{id} page
    // fastdlserver returns 302 to https://gdflix.dev/file/{id} which redirects
    // to https://new3.gdflix.io/file/{id} (HTML page with download buttons).
    const res1 = await gotScraping(url.href, {
      timeout: { request: 10000 },
      throwHttpErrors: false,
      followRedirect: true,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://bollyflix.free/',
      },
    });

    if (res1.statusCode >= 400 || !res1.body) return null;

    // Step 2: Extract the instant.busycdn.xyz URL from the /file/ page.
    // The URL has a specific format: instant.busycdn.xyz/{hash}::{hash}?bytes={size}
    // We need the FULL URL including the ?bytes= parameter (without it, busycdn
    // returns 500 "Cannot read properties of undefined").
    const busyCdnMatch = res1.body.match(/https:\/\/instant\.busycdn\.xyz\/[^"'\s<>]+/i);
    if (!busyCdnMatch) {
      // Older /cflare/ fallback — try the cloud-dl pattern (legacy)
      const cloudDlMatch = res1.body.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
      if (cloudDlMatch) {
        const resolved = cloudDlMatch[0];
        _resolveCache.set(url.href, { url: resolved, ts: Date.now() });
        return resolved;
      }
      return null;
    }

    const busycdnUrl = busyCdnMatch[0];

    // Step 3: Follow busycdn 302 redirect to fastdl-one.pages.dev/?url={googleusercontent_url}
    // We DON'T follow redirects here — we just want the Location header which
    // contains the fastdl-one.pages.dev URL with the googleusercontent URL in
    // the 'url' query parameter.
    const res2 = await gotScraping(busycdnUrl, {
      timeout: { request: 10000 },
      throwHttpErrors: false,
      followRedirect: false,  // We want the Location header, not the body
      headers: {
        'User-Agent': UA,
        'Referer': 'https://new3.gdflix.io/',
      },
    });

    if (res2.statusCode !== 302 || !res2.headers.location) {
      // busycdn didn't redirect — try with followRedirect to see if it serves
      // the file directly (some files may not need the pages.dev hop)
      return null;
    }

    // Step 4: Extract the 'url' query parameter from the Location header.
    // Location format: https://fastdl-one.pages.dev/?url={encoded googleusercontent URL}
    const locUrl = new URL(res2.headers.location);
    const downloadUrl = locUrl.searchParams.get('url');
    if (!downloadUrl || !downloadUrl.startsWith('http')) {
      return null;
    }

    // The googleusercontent URL is a direct playable video URL.
    // Cache and return.
    _resolveCache.set(url.href, { url: downloadUrl, ts: Date.now() });
    return downloadUrl;
  } catch (e) {
    console.error(`[pantyflix] resolveFastDlServer error: ${e.message}`);
    return null;
  }
}

export class Pantyflix extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'pantyflix';
    this.label = 'Pantyflix';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, url, meta) {
    // Claim both 'pantyflix' and 'bollyflix' source IDs — both return
    // dl.fastdlserver.site URLs that need to be resolved to direct cloud-dl
    // workers.dev URLs (fastdlserver → gdflix → cloud-dl workers.dev).
    return meta?.sourceId === this.id || meta?.sourceId === 'bollyflix';
  }

  async extractInternal(ctx, url, meta) {
    // If this is a fastdlserver URL, resolve it to a direct cloud-dl URL
    if (url.hostname.includes('fastdlserver')) {
      const resolvedUrl = await resolveFastDlServer(url);
      if (resolvedUrl) {
        try {
          const directUrl = new URL(resolvedUrl);
          // Google's video-downloads.googleusercontent.com doesn't support
          // HTTP Range requests — route through /range-proxy for Range
          // translation so Stremio can seek in the video.
          if (directUrl.hostname.includes('googleusercontent.com')) {
            const proxyUrl = new URL('/range-proxy', ctx.hostUrl);
            proxyUrl.searchParams.set('url', directUrl.href);
            return [{
              url: proxyUrl,
              format: Format.mp4,
              meta: { ...meta },
            }];
          }
          // Check if the resolved URL needs proxy
          if (NEEDS_PROXY.test(directUrl.hostname)) {
            const proxyUrl = new URL('/proxy', ctx.hostUrl);
            proxyUrl.searchParams.set('url', directUrl.href);
            return [{
              url: proxyUrl,
              format: Format.mp4,
              meta: { ...meta },
            }];
          }
          // Direct URL — works without proxy
          return [{
            url: directUrl,
            format: Format.mp4,
            meta: { ...meta },
          }];
        } catch { /* fall through to error */ }
      }
      // Resolution failed (gdflix /file/ page didn't have a busycdn URL,
      // OR busycdn didn't redirect to fastdl-one.pages.dev).
      // Route the fastdlserver URL through /proxy so Stremio can at least
      // attempt to play it. The proxy follows the redirect chain and Stremio
      // will detect non-video responses and skip to the next stream.
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      return [{
        url: proxyUrl,
        format: Format.mp4,
        meta: { ...meta },
      }];
    }

    // Non-fastdlserver URLs (googleusercontent, workers.dev, hakunaymatata, etc.)
    // Google's video-downloads.googleusercontent.com doesn't support Range —
    // route through /range-proxy for Range translation (seekable playback).
    if (url.hostname.includes('googleusercontent.com')) {
      const proxyUrl = new URL('/range-proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      return [{
        url: proxyUrl,
        format: Format.mp4,
        meta: { ...meta },
      }];
    }

    // Only proxy URLs that are known to fail with direct access.
    if (NEEDS_PROXY.test(url.hostname)) {
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      return [{
        url: proxyUrl,
        format: Format.mp4,
        meta: { ...meta },
      }];
    }

    // Direct URL — works without proxy
    const isHls = url.pathname.includes('.m3u8') || url.pathname.includes('/hls/');
    return [{
      url,
      format: isHls ? Format.hls : Format.mp4,
      meta: { ...meta },
    }];
  }
}
