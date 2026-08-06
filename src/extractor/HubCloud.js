// src/extractor/HubCloud.js
// Ported from research/webstreamr-mbg/src/extractor/HubCloud.ts

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { findCountryCodes, findHeight, HUBCLOUD_CACHE_TTL } from '../utils/index.js';
import { Extractor } from './Extractor.js';

/** Delay before retrying Hop 1 after a failed Hop 2 (ms). */
const RETRY_DELAY_MS = 2500;

const SERVER_CATEGORIES = [
  { buttonIncludes: 'FSLv2', buttonExcludes: '', label: 'HubCloud (FSLv2)', extractorId: 'hubcloud_fslv2', priority: 4, seekable: true },
  { buttonIncludes: 'FSL', buttonExcludes: 'FSLv2', label: 'HubCloud (FSL)', extractorId: 'hubcloud_fsl', priority: 5, seekable: true },
  { buttonIncludes: '10Gbps', buttonExcludes: '', label: 'HubCloud (10Gbps)', extractorId: 'hubcloud_fast', priority: 2, seekable: false },
  { buttonIncludes: 'PixelServer', buttonExcludes: '', label: 'HubCloud (PxlSrv)', extractorId: 'hubcloud_pixelserver', priority: 3, seekable: true },
  { buttonIncludes: 'PDL', buttonExcludes: '', label: 'HubCloud (PDL)', extractorId: 'hubcloud_pdl', priority: 1, seekable: false },
  { buttonIncludes: 'Download File', buttonExcludes: '', label: 'HubCloud (DF)', extractorId: 'hubcloud_direct', priority: 0, seekable: false },
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

export class HubCloud extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'hubcloud';
    this.label = 'HubCloud';
    this.cacheVersion = 12;
    this.ttl = HUBCLOUD_CACHE_TTL;
  }

  supports(_ctx, url) {
    return /hubcloud/.test(url.hostname);
  }

  async extractInternal(ctx, url, meta) {
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
              apiUrl.searchParams.set('download', '');
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
            const streamUrl = new URL(href);

            // Telegram CDN workers (workers.telegramcdn.workers.dev) have
            // per-file download quotas. When exceeded, they return 403 with
            // "The download quota for this file has been exceeded." These
            // streams are dead and can't play — filter them out at extraction
            // time so users don't see broken playback errors.
            if (/telegramcdn\.workers\.dev/.test(streamUrl.hostname)) {
              let quotaExceeded = false;
              try {
                await this.fetcher.head(ctx, streamUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  timeout: 5000,
                });
              } catch (e) {
                // HttpError with status 403 = quota exceeded
                if (e?.status === 403) quotaExceeded = true;
              }
              if (quotaExceeded) {
                this.logger?.info?.(`HubCloud: skipping dead telegramcdn stream (quota exceeded)`);
                continue;
              }
            }

            classified.push({
              url: streamUrl,
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
