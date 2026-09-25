// src/extractor/HubCloud.js
// Ported from research/webstreamr-mbg/src/extractor/HubCloud.ts

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { findCountryCodes, findHeight, HUBCLOUD_CACHE_TTL } from '../utils/index.js';
import { Extractor } from './Extractor.js';

/**
 * Task 41 (OOM fix): direct MEDIA FILE URLs must never be fetched as text or
 * delegated to HubCloud.extractInternal — that method fetches the URL as TEXT
 * to parse a redirect page, so handing it a file URL buffers the WHOLE VIDEO
 * in memory (observed: 3.4 GB RSS → kernel OOM-kill during a single merged
 * /stream request, after hubcdn pages began flowing through HubExtractor via
 * hblinks.co archives). Returns true for hosts/paths that ARE the media file
 * itself. Exported for HubExtractor's delegation decision too.
 */
export function isDirectFileUrl(url) {
  if (/\.r2\.dev$|(^|\.)r2\.cloudflarestorage\.com$/i.test(url.hostname)) return true;
  return /\.(mkv|mp4|avi|webm|mov|m3u8|ts)$/i.test(url.pathname);
}

/** Delay before retrying Hop 1 after a failed Hop 2 (ms). */
const RETRY_DELAY_MS = 2500;

const SERVER_CATEGORIES = [
  { buttonIncludes: 'FSLv2', buttonExcludes: '', label: 'HubCloud (FSLv2)', extractorId: 'hubcloud_fslv2', priority: 4, seekable: true },
  { buttonIncludes: 'FSL', buttonExcludes: 'FSLv2', label: 'HubCloud (FSL)', extractorId: 'hubcloud_fsl', priority: 5, seekable: true },
  { buttonIncludes: '10Gbps', buttonExcludes: '', label: 'HubCloud (10Gbps)', extractorId: 'hubcloud_fast', priority: 2, seekable: true },
  // PixelServer : 2 must come BEFORE PixelServer — otherwise 'PixelServer'
  // matches first and 'PixelServer : 2' (which links to pixeldrain.dev)
  // is never tested.
  { buttonIncludes: 'PixelServer : 2', buttonExcludes: '', label: 'HubCloud (PixelDrain)', extractorId: 'hubcloud_pixeldrain', priority: 6, seekable: true,
    transformUrl: (url) => {
      // pixeldrain.dev/u/{id} → pixeldrain.dev/api/file/{id}
      // (the /u/ page is an HTML viewer, /api/file/ returns the raw video)
      // Task 92: WITHOUT the ?download param — measured live, ?download makes
      // pixeldrain answer Content-Disposition: attachment (browser/web players
      // turn that into a FILE DOWNLOAD instead of playback) while the bare
      // /api/file/{id} answers Content-Disposition: inline with identical
      // 206/Range support → direct playable.
      const m = url.match(/pixeldrain\.(?:dev|com)\/u\/([^?&]+)/);
      if (m) return `https://pixeldrain.dev/api/file/${m[1]}`;
      const api = url.match(/pixeldrain\.(?:dev|com)\/api\/file\/([^?&]+)/);
      if (api) return `https://pixeldrain.dev/api/file/${api[1]}`;
      return url;
    }
  },
  { buttonIncludes: 'PixelServer', buttonExcludes: '', label: 'HubCloud (PxlSrv)', extractorId: 'hubcloud_pixelserver', priority: 3, seekable: true },
  { buttonIncludes: 'PDL', buttonExcludes: '', label: 'HubCloud (PDL)', extractorId: 'hubcloud_pdl', priority: 1, seekable: false,
    // Task 92: PDL links arrive as pixeldrain /api/file/{id}?download — the
    // ?download param flips pixeldrain to Content-Disposition: attachment
    // (download semantics). Strip it exactly like the PixelDrain category.
    transformUrl: (url) => {
      const api = url.match(/pixeldrain\.(?:dev|com)\/(?:api\/file|u)\/([^?&]+)/);
      if (api) return `https://pixeldrain.dev/api/file/${api[1]}`;
      return url;
    }
  },
  { buttonIncludes: 'Download File', buttonExcludes: '', label: 'HubCloud (Download)', extractorId: 'hubcloud_direct', priority: 0, seekable: true,
    // Task 92: hubcloud's "Download File" workers.dev URLs (terapiyoNNN class)
    // flap between 206 and 403 — measured live: same URL 206 at issue time,
    // 403 two minutes later, 206 again at +5min; some hosts 403 the first two
    // requests then 200. A dead card = "can't play" in Stremio. Liveness-gate
    // these URLs (Range GET, one flap-tolerant retry) and drop them when they
    // refuse to stream — same honest-card doctrine as the animezey probe gate.
    validate: true,
  },
];

const LABEL_TO_SEEKABLE = new Map(
  SERVER_CATEGORIES.map(c => [c.label, c.seekable]),
);

const REDIRECT_STRATEGIES = [
  html => html.match(/var url\s*=\s*['"](.*?)['"]/)?.[1] ?? null,

  html => html.match(/window\.location(?:\.href)?\s*=\s*['"](.*?)['"]/)?.[1] ?? null,

  html => html.match(/location\.replace\(['"](.*?)['"]\)/)?.[1] ?? null,

  html => html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;\s*url=(.*?)["']/i)?.[1] ?? null,

  html => html.match(/document\.location(?:\.href)?\s*=\s*['"](.*?)['"]/)?.[1] ?? null,

  html => html.match(/location\.href\s*=\s*['"](.*?)['"]/)?.[1] ?? null,

  html => html.match(/location\.assign\(['"](.*?)['"]\)/)?.[1] ?? null,

  html => html.match(/window\.open\(['"](.*?)['"]/)?.[1] ?? null,

  html => html.match(/data-(?:url|href|link)\s*=\s*['"](.*?)['"]/)?.[1] ?? null,

  (html) => {
    const m = html.match(/<iframe[^>]+src\s*=\s*['"](.*?)['"]/);
    if (m?.[1] && (m[1].includes('hubcloud') || m[1].includes('gamerxyt'))) return m[1];
    return null;
  },

  (html) => {
    const m = html.match(/var\s+\w+\s*=\s*['"]([^'"]*(?:hubcloud|gamerxyt|hubdrive|hubcdn)[^'"]*)['"]/);
    return m?.[1] ?? null;
  },

  (html) => {
    const m = html.match(/https?:\/\/(?:hubcloud\.[a-z.]+|hubdrive\.[a-z.]+|gamerxyt\.com|hubcdn)[^\s'"<>)]+/);
    return m?.[0] ?? null;
  },
];

// ─── JS href-override patching ─────────────────────────────────────────
// HubCloud worker pages (2025+) hide the REAL download href behind a tiny
// inline script: the static <a href> points at a dead DMCA honeypot file and
// a script swaps in the live URL before the user clicks:
//   <a id="pxl-1" href="https://pixeldrain.dev/u/DEADID">Download [PixelServer : 2]</a>
//   <script> var pxl = "https://pixeldrain.dev/u/LIVEID";
//            document.getElementById("pxl-1").href = pxl; </script>
// Server-side parsing saw the dead href. applyJsHrefOverrides() rewrites the
// anchor hrefs with their scripted values so every downstream category
// extractor sees the real links. Conservative: no script → HTML unchanged.

export function applyJsHrefOverrides(html) {
  if (!html || !html.includes('getElementById')) return html;

  // 1. Collect simple string assignments: var name = "url" (single/double quotes)
  const varMap = new Map();
  for (const m of html.matchAll(/var\s+(\w+)\s*=\s*(["'])([^"'"<>]{8,}?)\2/g)) {
    varMap.set(m[1], m[3]);
  }

  // 2. Collect getElementById("id").href = "literal" | varName
  const idToUrl = new Map();
  for (const m of html.matchAll(/document\.getElementById\((["'])([^"']+)\1\)\.href\s*=\s*(?:["']([^"'"<>]+)["']|([\w$]+))/g)) {
    const id = m[2];
    const value = m[3] ?? varMap.get(m[4]);
    if (value && /^https?:\/\/|^\//.test(value)) idToUrl.set(id, value);
  }
  if (idToUrl.size === 0) return html;

  // 3. Rewrite the matching anchor's href (id attribute may precede or follow href)
  let out = html;
  for (const [id, url] of idToUrl) {
    const anchorRe = new RegExp(`<a\\b[^>]*\\bid=["']${id}["'][^>]*>`);
    const anchorMatch = out.match(anchorRe);
    if (!anchorMatch) continue;
    const patched = anchorMatch[0].replace(/(\shref=)(["'])[^"']*\2/i, `$1$2${url}$2`);
    if (patched !== anchorMatch[0]) out = out.replace(anchorMatch[0], patched);
  }
  return out;
}

export class HubCloud extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'hubcloud';
    this.label = 'HubCloud';
    this.cacheVersion = 13;
    // Short TTL (30s) — HubCloud workers.dev URLs contain session tokens
    // that expire quickly. With 5min TTL, cached URLs would be stale
    // by the time Stremio plays them, causing 403 "Access Denied".
    this.ttl = HUBCLOUD_CACHE_TTL;
  }

  supports(_ctx, url) {
    return /hubcloud/.test(url.hostname);
  }

  async extractInternal(ctx, url, meta) {
    // Task 41 (OOM fix): belt-and-suspenders — if a caller hands us a DIRECT
    // FILE URL (r2.dev / media extension), there is no redirect page to
    // parse. Fetching it as text would buffer the whole video in memory.
    // Ship it as a direct card instead (same card the delegation would have
    // produced, minus the fatal file-as-text download).
    if (isDirectFileUrl(url)) {
      const hls = /\.m3u8$/i.test(url.pathname);
      return [{
        url,
        format: hls ? Format.hls : Format.mp4,
        meta: { ...meta, extractorId: 'hubcloud_directfile' },
        label: 'HubCloud (Direct)',
        seekable: !hls,
      }];
    }
    const headers = { Referer: meta.referer ?? url.href };

    const redirectHtml = await this.fetcher.text(ctx, url, { headers });
    const rawRedirectUrl = this.extractRedirectUrl(redirectHtml);
    if (!rawRedirectUrl) {
      return [];
    }

    const redirectUrl = rawRedirectUrl.startsWith('http') ? rawRedirectUrl : `${url.origin}${rawRedirectUrl}`;

    const cookieName = this.extractCookieName(redirectHtml);
    if (cookieName) {
      this.fetcher.setCookie(redirectUrl, `${cookieName}=s4t`);
    }

    let linksHtml = await this.fetcher.text(ctx, new URL(redirectUrl), { headers: { Referer: url.href } });
    linksHtml = applyJsHrefOverrides(linksHtml);
    let $ = cheerio.load(linksHtml);

    if (!this.hasValidDownloadContent($)) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));

      const retryHtml = await this.fetcher.text(ctx, url, { headers });
      const rawRetryRedirectUrl = this.extractRedirectUrl(retryHtml);
      if (rawRetryRedirectUrl) {
        const retryRedirectUrl = rawRetryRedirectUrl.startsWith('http') ? rawRetryRedirectUrl : `${url.origin}${rawRetryRedirectUrl}`;
        const retryCookieName = this.extractCookieName(retryHtml);
        if (retryCookieName) {
          this.fetcher.setCookie(retryRedirectUrl, `${retryCookieName}=s4t`);
        }
        linksHtml = await this.fetcher.text(ctx, new URL(retryRedirectUrl), { headers: { Referer: url.href } });
        linksHtml = applyJsHrefOverrides(linksHtml);
        $ = cheerio.load(linksHtml);
      }

      if (!this.hasValidDownloadContent($)) {
        return [];
      }
    }

    const title = $('title').text().trim();
    const countryCodes = [...new Set([...meta.countryCodes ?? [], ...findCountryCodes(title)])];
    const height = meta.height ?? findHeight(title);
    const fileSize = bytes.parse($('#size').text());

    const allLinks = $('a').toArray();
    const classified = [];
    const matchedIndices = new Set();

    for (const category of SERVER_CATEGORIES) {
      for (const [i, el] of allLinks.entries()) {
        if (matchedIndices.has(i)) continue;

        const text = $(el).text();
        const href = $(el).attr('href');

        if (!href || href.toLowerCase().includes('.zip')) continue;

        if (text.includes(category.buttonIncludes) && (category.buttonExcludes === '' || !text.includes(category.buttonExcludes))) {
          matchedIndices.add(i);

          if (category.buttonIncludes === 'PixelServer') {
            try {
              const userUrl = new URL(href.replace('/api/file/', '/u/'));
              const apiUrl = new URL(userUrl.href.replace('/u/', '/api/file/'));
              // Task 92: no ?download param — pixeldrain serves Content-Disposition:
              // attachment with it (download semantics) and inline without it.
              await this.fetcher.head(ctx, apiUrl, { headers: { Referer: userUrl.href } });
              classified.push({
                url: apiUrl,
                format: Format.unknown,
                ttl: HUBCLOUD_CACHE_TTL,
                label: category.label,
                meta: { ...meta, bytes: fileSize, extractorId: category.extractorId, countryCodes, height, title },
                requestHeaders: { Referer: userUrl.href },
              });
            } catch {
              // PixelServer link is dead — skip it
            }
          } else {
            // Apply URL transform if the category has one (e.g. PixelDrain
            // converts /u/{id} viewer page → /api/file/{id})
            const finalUrl = category.transformUrl ? category.transformUrl(href) : href;
            // Task 92: liveness gate for download-class URLs (workers.dev token
            // files that flap 206↔403). Range-GET the URL with its Referer;
            // one flap-tolerant retry after a short delay; drop on persistent
            // 4xx/5xx so the user never sees a dead "can't play" card.
            if (category.validate) {
              const ok = await this.validateStreamUrl(finalUrl, meta.referer ?? url.href);
              if (!ok) {
                this.logger.warn(`[hubcloud] dropping dead Download URL: ${String(finalUrl).slice(0, 90)}`);
                continue;
              }
            }
            classified.push({
              url: new URL(finalUrl),
              format: Format.unknown,
              ttl: HUBCLOUD_CACHE_TTL,
              label: category.label,
              meta: {
                ...meta,
                bytes: fileSize,
                extractorId: category.extractorId,
                countryCodes,
                height,
                title: category.seekable ? title : `${title} ⚠️ no seek`,
              },
            });
          }
        }
      }
    }

    const seekableResults = classified.filter(r => LABEL_TO_SEEKABLE.get(r.label) === true);

    if (seekableResults.length > 0) {
      const hasSeekableForFile = (result) =>
        seekableResults.some(s => s.meta?.bytes === result.meta?.bytes);

      return classified.filter((r) => {
        if (LABEL_TO_SEEKABLE.get(r.label) === true) return true;
        return !hasSeekableForFile(r);
      });
    }

    return classified;
  }

  /**
   * Task 92: liveness probe for download-class direct-file URLs.
   * Range-GETs the first byte pair (headers only — body cancelled immediately,
   * Task 41 OOM doctrine). These workers.dev token URLs flap: measured live,
   * the same URL answered 206 → 403 (+2min) → 206 (+5min), and some hosts 403
   * the first requests before serving. So: a failed attempt is retried ONCE
   * after a 2s pause (flap tolerance); only a persistent 4xx/5xx or a network
   * failure on both attempts drops the card. Errors (timeouts) are treated as
   * alive — a slow host is better than a missing card, and the probe must not
   * spend more than ~10s per URL worst case.
   */
  async validateStreamUrl(urlStr, referer) {
    let parsed;
    try { parsed = new URL(urlStr); } catch { return false; }
    const headers = { Referer: referer ?? parsed.href };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(parsed.href, {
          headers: { ...headers, Range: 'bytes=0-1' },
          redirect: 'follow',
          signal: AbortSignal.timeout(6000),
        });
        try { res.body?.cancel?.(); } catch {}
        if (res.status < 400 || res.status === 416) return true;
        if (res.status >= 400 && attempt === 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        return false;
      } catch {
        // network error / timeout — treat as alive (do not drop on our own
        // egress flakiness); only upstream CONFIRMED 4xx/5xx answers kill cards
        return true;
      }
    }
    return false;
  }

  extractRedirectUrl(html) {
    for (let i = 0; i < REDIRECT_STRATEGIES.length; i++) {
      const strategy = REDIRECT_STRATEGIES[i];
      const result = strategy(html);
      if (result) {
        if (i === REDIRECT_STRATEGIES.length - 1) {
          this.logger.warn(`Brute-force URL extraction used — redirect strategy array may need updating. Extracted: ${result}`);
        }
        return result;
      }
    }
    return null;
  }

  extractCookieName(html) {
    const cookieMatch = html.match(/stck\(\s*['"](\w+)['"]\s*,/);
    return cookieMatch ? cookieMatch[1] : null;
  }

  hasValidDownloadContent($) {
    if ($('#size').length > 0 || $('a:contains("FSL")').length > 0 || $('a:contains("PixelServer")').length > 0) {
      return true;
    }

    const extendedSelectors = [
      'a#download',
      'a[href*="hubcloud.php"]',
      'a[href*="gamerxyt.com"]',
      'a[href*="hubcloud.one"]',
      'a[href*="workers.dev"]',
      'a[href*="hubcdn"]',
      '.download-btn',
      'a[href*="download"]',
      'a.btn.btn-primary',
      '.btn-success',
      '.btn-danger',
    ];
    for (const selector of extendedSelectors) {
      if ($(selector).length > 0) {
        return true;
      }
    }

    return false;
  }
}
