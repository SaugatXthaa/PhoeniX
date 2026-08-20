// src/extractor/Pantyflix.js
// Extractor for Pantyflix + BollyFlix direct download streams.
//
// Both sources return dl.fastdlserver.site URLs that need to be resolved:
//   fastdlserver → gdflix page → /cflare/ → cloud-dl workers.dev direct URL
//
// The resolution uses got-scraping (not curl) for Render compatibility.
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

// Resolve fastdlserver URL to direct playable URL using got-scraping.
// Chain: fastdlserver → gdflix page → /cflare/ → cloud-dl workers.dev
async function resolveFastDlServer(url) {
  // Check cache first
  const cached = _resolveCache.get(url.href);
  if (cached && Date.now() - cached.ts < RESOLVE_CACHE_TTL) {
    return cached.url;
  }

  const gotScraping = await getGotScraping();
  if (!gotScraping) return null;

  try {
    // Step 1: Fetch fastdlserver page
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

    // Try direct cloud-dl URL first
    const directMatch = res1.body.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
    if (directMatch) {
      const resolved = directMatch[0];
      _resolveCache.set(url.href, { url: resolved, ts: Date.now() });
      return resolved;
    }

    // Extract /cflare/ link
    const cflareMatch = res1.body.match(/href="(\/cflare\/[^"]+)"/);
    if (!cflareMatch) return null;

    // Step 2: Fetch cflare page
    const cflareUrl = `https://new3.gdflix.io${cflareMatch[1]}`;
    const res2 = await gotScraping(cflareUrl, {
      timeout: { request: 10000 },
      throwHttpErrors: false,
      followRedirect: true,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://new3.gdflix.io/',
      },
    });

    if (res2.statusCode >= 400 || !res2.body) return null;

    // Extract direct URL (cloud-dl workers.dev or busycdn)
    const cloudDlMatch = res2.body.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
    if (cloudDlMatch) {
      const resolved = cloudDlMatch[0];
      _resolveCache.set(url.href, { url: resolved, ts: Date.now() });
      return resolved;
    }

    const busyCdnMatch = res2.body.match(/https:\/\/instant\.busycdn\.xyz[^"'\s<>]+/i);
    if (busyCdnMatch) {
      const resolved = busyCdnMatch[0];
      _resolveCache.set(url.href, { url: resolved, ts: Date.now() });
      return resolved;
    }

    return null;
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
      // Resolution failed (gdflix now requires Cloudflare Turnstile challenge).
      // Route the fastdlserver URL through /proxy so Stremio can at least
      // attempt to play it. The proxy follows the redirect chain:
      //   fastdlserver → gdflix.dev/file/{id} (HTML page with download button)
      // Stremio will get an HTML response, detect that it's not a video,
      // and skip to the next stream. This is better UX than hiding the
      // stream entirely — the user sees that BollyFlix found a result.
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      return [{
        url: proxyUrl,
        format: Format.mp4,
        meta: { ...meta },
      }];
    }

    // Non-fastdlserver URLs (googleusercontent, workers.dev, hakunaymatata, etc.)
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
