// src/source/MeineCloud.js
// Ported from research/webstreamr-mbg/src/source/MeineCloud.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

export class MeineCloud extends Source {
  constructor(fetcher) {
    super();
    this.id = 'meinecloud';
    this.label = 'MeineCloud';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.de];
    this.baseUrl = 'https://meinecloud.click';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const imdbId = await getImdbId(this.fetcher, ctx, id);

    // Also resolve TMDB info for the VidKing fallback
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    let name, year;
    try {
      [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    } catch { /* best-effort */ }

    const vidkingMeta = {
      ...(name && { name }),
      ...(year && { year }),
      tmdbId: tmdbId.id,
      imdbId: imdbId.id,
    };

    const pageUrl = new URL(`/movie/${imdbId.id}`, this.baseUrl);

    try {
      const html = await this.fetcher.text(ctx, pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://meinecloud.click/',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 30000, // Task 86: upstream serves first byte after a ~19-20s
        // server-side delay (verified from a clean egress 3/3 — 19.4-19.7s per
        // page fetch, zero variance = deliberate tarpit, not network loss).
        // The old 15s cap aborted EVERY page fetch → permanent zero since the
        // delay was introduced. 30s fits the /debug 35s race; the merged
        // resolver still budget-caps slower fetches per wave.
      });

      const $ = cheerio.load(html);

      const results = [];

      $('[data-link!=""]').each((_i, el) => {
        let link = $(el).attr('data-link')?.trim();
        if (!link) return;

        // Task 28 root-cause fix: data-link values are BASE64-ENCODED embed
        // URLs (e.g. "Ly9kcjBwc3RyZWFtLmNvbS9lL21md3dlZGMwZTNmZQ==" →
        // "//dr0pstream.com/e/mfwwec0e3fe"). The previous code never decoded
        // them — it prepended "https://" to the raw base64 string, producing
        // garbage URLs that matched no extractor (the whole source silently
        // delivered 0). Decode first; fall back to raw when it isn't base64.
        if (!/^[a-z]+:\/\//i.test(link) && !link.startsWith('//')) {
          try {
            const decoded = Buffer.from(link, 'base64').toString('utf8');
            if (/^(https?:)?\/\//.test(decoded) && !/[\x00-\x1f]/.test(decoded)) {
              link = decoded;
            }
          } catch { /* not base64 — keep raw */ }
        }

        if (link.startsWith('//')) {
          link = 'https:' + link;
        } else if (!link.startsWith('http')) {
          link = 'https://' + link;
        }

        try {
          const url = new URL(link);

          // Skip internal links
          if (url.host.includes('meinecloud')) {
            return;
          }

          results.push({
            url: url,
            meta: {
              countryCodes: [CountryCode.de],
              referer: this.baseUrl,
              ...(vidkingMeta && { vidking: vidkingMeta }),
            },
          });
        } catch {
          // invalid URL, skip
        }
      });

      return results;
    } catch (error) {
      console.error(`[MeineCloud] Error fetching ${pageUrl.href}:`, error.message || error);
      return [];
    }
  }
}
