// src/extractor/HubExtractor.js
// Ported from research/webstreamr-mbg/src/extractor/HubExtractor.ts

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { DEAD_HUBCLOUD_HOSTS, findCountryCodes, findHeight, HUB_HOST_PATTERN, HUBCLOUD_CACHE_TTL } from '../utils/index.js';
import { Extractor } from './Extractor.js';
import { HubCloud } from './HubCloud.js';

/** True CDN (GDrive) vs HubCloud host that would duplicate. */
const isCdnDirectUrl = (url) => /googleusercontent\.com/.test(url.hostname);

/** FNV-1a hash of URL pathname — unique bingeGroup per CDN link */
export const cdnHash = (url) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.pathname.length; i++) {
    hash ^= url.pathname.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 4);
};

const DEFAULT_EVICTION_THRESHOLD = 256;

export class HubExtractor extends Extractor {
  constructor(fetcher, logger, hubCloud, evictionThreshold) {
    super(fetcher, logger);
    this.id = 'hub';
    this.label = 'HubCloud';
    this.lazyExtract = true;
    this.cacheVersion = 2;
    this.ttl = HUBCLOUD_CACHE_TTL;
    this.hubCloud = hubCloud ?? new HubCloud(fetcher, logger);
    this.evictionThreshold = evictionThreshold ?? DEFAULT_EVICTION_THRESHOLD;
    this.resolutionCache = new Map();
    this.hubCdnCache = new Map();
  }

  supports(_ctx, url) {
    return HUB_HOST_PATTERN.test(url.hostname);
  }

  // Resolve to canonical form for cache key; hubcdn→hubcloud strip, hubcloud strip ?token=, hubdrive resolve→strip
  async normalizeAsync(ctx, url) {
    // HubCDN: resolve→hubcloud canonical or as-is for direct video hosts
    if (/hubcdn/.test(url.hostname)) {
      try {
        const result = await this.resolveHubCdnUrl(ctx, url);
        if (result?.delegateToHubCloud) {
          return this.stripQueryParams(result.url);
        }
      } catch {
        // fall through
      }
      return url;
    }

    // HubCloud: strip ephemeral ?token= for canonical cache key only
    if (/hubcloud/.test(url.hostname)) {
      return this.stripQueryParams(url);
    }

    // HubDrive: resolve→hubcloud then strip query params
    const cached = this.resolutionCache.get(url.href);
    if (cached && Date.now() - cached.ts < HUBCLOUD_CACHE_TTL) {
      return this.stripQueryParams(cached.url);
    }

    try {
      const resolved = await this.resolveHubDriveToHubCloud(ctx, url);
      if (resolved) {
        this.resolutionCache.set(url.href, { url: resolved.url, meta: resolved.meta, ts: Date.now() });
        if (this.resolutionCache.size > this.evictionThreshold) {
          this.evictExpired(this.resolutionCache);
        }
        return this.stripQueryParams(resolved.url);
      }
    } catch {
      // fall through
    }

    return url;
  }

  async extractInternal(ctx, url, meta) {
    if (DEAD_HUBCLOUD_HOSTS.has(url.hostname)) {
      return [];
    }

    // HubCDN → may redirect to HubCloud (needs further extraction) or direct video URL
    if (/hubcdn/.test(url.hostname)) {
      try {
        const result = await this.resolveHubCdnUrl(ctx, url);
        if (!result) return [];
        if (result.delegateToHubCloud) {
          try {
            return await this.hubCloud.extractInternal(ctx, result.url, meta);
          } catch { return []; }
        }
        // True CDN direct URL (googleusercontent.com)
        return [{
          url: result.url,
          format: Format.unknown,
          meta: { ...meta, extractorId: `hub_cdn_${cdnHash(url)}` },
          label: 'HubCloud (CDN)',
        }];
      } catch {
        return [];
      }
    }

    // HubDrive → try resolution cache first, then fallback
    if (/hubdrive/.test(url.hostname)) {
      const cached = this.resolutionCache.get(url.href);
      if (cached && Date.now() - cached.ts < HUBCLOUD_CACHE_TTL) {
        try {
          const enrichedMeta = { ...cached.meta, ...meta, countryCodes: [...new Set([...(cached.meta.countryCodes ?? []), ...(meta.countryCodes ?? [])])] };
          return await this.hubCloud.extractInternal(ctx, cached.url, enrichedMeta);
        } catch {
          return [];
        }
      }

      return this.extractViaHubCloud(ctx, url, meta);
    }

    // HubCloud → delegate directly
    return await this.hubCloud.extractInternal(ctx, url, meta);
  }

  // Resolve HubDrive page to HubCloud URL + page metadata
  async resolveHubDriveToHubCloud(ctx, url) {
    let html;
    try {
      html = await this.fetcher.text(ctx, url, { headers: { Referer: url.href } });
    } catch {
      return null;
    }

    const $ = cheerio.load(html);
    const hubCloudUrl = this.findHubCloudUrl($);
    if (!hubCloudUrl) return null;

    return { url: hubCloudUrl, meta: this.extractHubDriveMeta($) };
  }

  // Extract metadata from HubDrive page (title, countryCodes, height, bytes)
  extractHubDriveMeta($) {
    const pageTitle = $('title').text().replace(/^HubDrive\s*\|\s*/, '').trim();
    const fileSizeText = $('td').filter((_i, el) => $(el).text().trim() === 'File Size').next().text().trim();
    const countryCodes = findCountryCodes(pageTitle);
    const height = findHeight(pageTitle);

    return {
      ...(pageTitle && { title: pageTitle }),
      ...(countryCodes.length > 0 && { countryCodes }),
      ...(height !== undefined && { height }),
      ...(fileSizeText && { bytes: bytes.parse(fileSizeText) }),
    };
  }

  // Find HubCloud link on HubDrive page
  findHubCloudUrl($) {
    const hubCloudUrl = $('a:contains("HubCloud")')
      .map((_i, el) => {
        const href = $(el).attr('href');
        if (!href) return null;
        try {
          const parsed = new URL(href);
          if (DEAD_HUBCLOUD_HOSTS.has(parsed.hostname)) return null;
          return parsed;
        } catch {
          return null;
        }
      })
      .get(0);

    return hubCloudUrl ?? null;
  }

  // Fallback extraction when normalizeAsync resolution failed
  async extractViaHubCloud(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    let html;
    try {
      html = await this.fetcher.text(ctx, url, { headers });
    } catch {
      return [];
    }

    const $ = cheerio.load(html);
    const hubCloudUrl = this.findHubCloudUrl($);

    if (!hubCloudUrl) {
      return [];
    }

    const hubDriveMeta = this.extractHubDriveMeta($);
    const enrichedMeta = { ...hubDriveMeta, ...meta, countryCodes: [...new Set([...(hubDriveMeta.countryCodes ?? []), ...(meta.countryCodes ?? [])])] };

    try {
      return await this.hubCloud.extractInternal(ctx, hubCloudUrl, enrichedMeta);
    } catch {
      return [];
    }
  }

  evictExpired(cache) {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.ts >= HUBCLOUD_CACHE_TTL) {
        cache.delete(key);
      }
    }
  }

  // Resolve HubCDN URL with in-memory cache to avoid double-fetch between normalizeAsync and extractInternal
  async resolveHubCdnUrl(ctx, url) {
    const cached = this.hubCdnCache.get(url.href);
    if (cached && Date.now() - cached.ts < HUBCLOUD_CACHE_TTL) {
      return cached.result;
    }

    const headers = { Referer: url.href };
    const html = await this.fetcher.text(ctx, url, { headers });
    const result = this.extractHubCdnUrl(html);

    if (result) {
      this.hubCdnCache.set(url.href, { result, ts: Date.now() });
      if (this.hubCdnCache.size > this.evictionThreshold) {
        this.evictExpired(this.hubCdnCache);
      }
    }

    return result;
  }

  // Unified HubCDN extraction — handles /dl/?link=, ?r=BASE64, <a id="vd">, googleusercontent
  extractHubCdnUrl(html) {
    // Pattern 1: var reurl = "..."
    const reurlMatch = html.match(/var\s+reurl\s*=\s*["']([^"']+)["']/);
    if (reurlMatch?.[1]) {
      const reurlValue = reurlMatch[1];

      // 1a: /dl/?link=URL → extract link param
      if (reurlValue.includes('hubcdn') && reurlValue.includes('/dl/?link=')) {
        try {
          const linkParam = new URL(reurlValue).searchParams.get('link');
          if (linkParam) {
            const targetUrl = new URL(linkParam);
            return { url: targetUrl, delegateToHubCloud: !isCdnDirectUrl(targetUrl) };
          }
        } catch { /* fallthrough */ }
      }

      // 1b: ?r=BASE64 → decode (alternative mirror format)
      const rMatch = reurlValue.match(/[?&]r=([A-Za-z0-9+/=]+)/);
      if (rMatch?.[1]) {
        try {
          const decoded = atob(rMatch[1]);
          const linkMatch = decoded.match(/[?&]link=(.+)$/);
          const finalUrl = linkMatch?.[1] ? new URL(decodeURIComponent(linkMatch[1])) : new URL(decoded);
          return { url: finalUrl, delegateToHubCloud: !isCdnDirectUrl(finalUrl) };
        } catch { /* fallthrough */ }
      }

      // 1c: Plain URL (direct video URL — skip self-referential hubcdn/dl/ URLs)
      if (!reurlValue.includes('/dl/?link=')) {
        try {
          const directUrl = new URL(reurlValue);
          return { url: directUrl, delegateToHubCloud: !isCdnDirectUrl(directUrl) };
        } catch { /* fallthrough */ }
      }
    }

    // Pattern 2: <a id="vd" href='URL'>
    const vdMatch = html.match(/<a\s+id=["']vd["']\s+href=["']([^"']+)["']/i);
    if (vdMatch?.[1]) {
      try {
        const vdUrl = new URL(vdMatch[1]);
        return { url: vdUrl, delegateToHubCloud: !isCdnDirectUrl(vdUrl) };
      } catch { /* next */ }
    }

    // Pattern 3: any googleusercontent.com URL (fallback) — always CDN direct
    const gdriveMatch = html.match(/(https?:\/\/[^\s"'<>]*googleusercontent\.com[^\s"'<>]*)/);
    if (gdriveMatch?.[1]) {
      try {
        return { url: new URL(gdriveMatch[1]), delegateToHubCloud: false };
      } catch { /* next */ }
    }

    return null;
  }

  // Strip query params for canonical cache key
  stripQueryParams(url) {
    const canonical = new URL(url);
    canonical.search = '';
    return canonical;
  }
}
