// src/source/TwoDhive.js
// 2dhive.com — MAL-ID-keyed anime-only archive (~10,648 titles)
//
// Flow (clean JSON API, no scraping):
//   1. Search: GET https://2dhive.com/api/search?q={title}
//      → {results:[{id (MAL ID), title, englishTitle, type, episodes, year, ...}]}
//   2. Build embed URL directly (no need to fetch /episode page):
//      https://megaplay.buzz/stream/mal/{malId}/{ep}/{sub|dub}
//   3. The Megaplay extractor handles resolving to direct m3u8 via getSourcesNew
//
// Both SUB and DUB streams are returned (DUB may 410 for titles without dubs,
// which the Megaplay extractor handles gracefully).
//
// The site also has a BabaStream secondary server (babastream.top/embed/{id}/{ep}/{sub|dub})
// but it's CF-Turnstile-protected (403) and not viable server-side.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://2dhive.com';
const SEARCH_API = 'https://2dhive.com/api/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function apiGet(url) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

export class TwoDhive extends Source {
  constructor(fetcher) {
    super();
    this.id = '2dhive';
    this.label = '2Dhive';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search for the anime to get its MAL ID
    const malId = await this.findMalId(name);
    if (!malId) return [];

    // Step 2: Build embed URLs for both sub and dub
    // The Megaplay extractor handles resolving to direct m3u8
    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const results = [];

    for (const subDub of ['sub', 'dub']) {
      const embedUrl = `https://megaplay.buzz/stream/mal/${malId}/${epNum}/${subDub}`;
      const audioLabel = subDub === 'dub' ? 'Dub' : 'Sub';
      const countryCodes = subDub === 'dub'
        ? [CountryCode.multi, CountryCode.en]
        : [CountryCode.multi, CountryCode.ja];

      results.push({
        url: new URL(embedUrl),
        meta: {
          countryCodes,
          title: `${title} (${audioLabel})`,
          sourceId: this.id,
          sourceLabel: this.label,
        },
      });
    }

    return results;
  }

  // Search 2dhive by name and return the MAL ID of the best match
  async findMalId(name) {
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const nameNorm = normalize(name);

    for (const query of queries) {
      const url = `${SEARCH_API}?q=${encodeURIComponent(query)}`;
      const data = await apiGet(url);
      if (!data?.results?.length) continue;

      let best = null;
      let bestScore = 0;
      for (const r of data.results) {
        const titles = [r.title, r.englishTitle].filter(Boolean);
        let itemBest = 0;
        for (const t of titles) {
          const tNorm = normalize(t);
          if (!tNorm) continue;
          let score = 0;
          if (tNorm === nameNorm) score = 100;
          else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
            score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
          }
          if (score > itemBest) itemBest = score;
        }
        if (itemBest > bestScore) {
          bestScore = itemBest;
          best = r;
        }
      }

      if (best && bestScore >= 0.6) return best.id;
    }

    return null;
  }
}
