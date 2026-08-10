// src/source/Fshare.js
// fsharetv.cc — movies-only direct stream provider
//
// Ported from cinepro-org/core/src/providers/fshare
// FshareTV serves movies via a 3-step flow:
//   1. GET /movie/{slug}-episode-1-{imdbId} → HTML page, find /w/{watchPath} link
//   2. GET /w/{watchPath}            → HTML page, extract source_id (multiple regex patterns)
//   3. GET /api/file/{sourceId}/source → JSON with stream_urls (m3u8 + mp4 backups)
//
// Movies only — no TV support.
// The URL pattern requires a title slug: /movie/{title-slug}-episode-1-{imdbId}
// We construct the slug from the TMDB title and verify with a HEAD check.

import { CountryCode } from '../types.js';
import { getImdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://fsharetv.cc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class Fshare extends Source {
  constructor(fetcher) {
    super();
    this.id = 'fshare';
    this.label = 'FshareTV';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const imdbIdObj = await getImdbId(this.fetcher, ctx, id);
    if (!imdbIdObj?.id) return [];

    const [name] = await getTmdbNameAndYear(this.fetcher, ctx, id);
    if (!name) return [];

    // Construct the URL: /movie/{title-slug}-episode-1-{imdbId}
    const slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    const path = `/movie/${slug}-episode-1-${imdbIdObj.id}`;
    const url = new URL(path, BASE_URL);

    // Verify the URL exists (HEAD check)
    try {
      const { gotScraping } = await import('got-scraping');
      const checkRes = await gotScraping.head(url.href, {
        headers: { 'User-Agent': UA },
        timeout: { request: 8000 },
        throwHttpErrors: false,
        followRedirect: true,
      });
      if (checkRes.statusCode === 404) return [];
      if (checkRes.statusCode >= 400) return [];
    } catch { return []; }

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title: `FshareTV`,
      },
    }];
  }
}
