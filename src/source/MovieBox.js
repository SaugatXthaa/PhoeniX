// src/source/MovieBox.js
// movie-box.co — movies, series, anime, kdrama with direct MP4 URLs
//
// Flow (clean JSON API, no scraping):
//   1. Get JWT token: POST /subject/search-suggest → extract from x-user header
//   2. Search: POST /subject/search → [{subjectId, title, releaseDate, detailPath, ...}]
//   3. Play: GET /subject/play?subjectId=...&se=...&ep=...&detailPath=...&streamSignType=1
//      → {streams: [{url, resolutions, vipLocked, ...}]}
//   4. Stream URLs are direct MP4 on hakunaymatata.com CDN — no Referer needed
//
// The API requires:
//   - Authorization: Bearer {jwt} (from search-suggest)
//   - Referer: https://movie-box.co/movies/{detailPath} (for /subject/play only)
//   - X-Client-Info: {timezone: "UTC"}
//   - X-Request-Lang: en
//
// JWT token is anonymous (auto-issued), lasts 90 days, reusable across IPs.
// Stream URLs are time-limited (~1 hour) — don't cache them.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const API_BASE = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const SITE_BASE = 'https://movie-box.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// JWT token cache (90 days, but refresh weekly for safety)
let jwtToken = null;
let jwtTokenTs = 0;
const JWT_TTL = 60 * 60 * 1000; // 1 hour (was 7 days — token expires faster)

async function getJwt() {
  if (jwtToken && Date.now() - jwtTokenTs < JWT_TTL) return jwtToken;
  const { gotScraping } = await import('got-scraping');
  const r = await gotScraping.post(`${API_BASE}/subject/search-suggest`, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ keyword: 'a', perPage: 1 }),
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  if (r.statusCode !== 200 || !r.headers['x-user']) return null;
  try {
    const data = JSON.parse(r.headers['x-user']);
    jwtToken = data.token;
    jwtTokenTs = Date.now();
    return jwtToken;
  } catch { return null; }
}

async function apiPost(path, body) {
  const jwt = await getJwt();
  if (!jwt) return null;
  const { gotScraping } = await import('got-scraping');
  const r = await gotScraping.post(`${API_BASE}${path}`, {
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json',
      'Authorization': `Bearer ${jwt}`,
      'X-Client-Info': JSON.stringify({ timezone: 'UTC' }),
      'X-Request-Lang': 'en',
    },
    body: JSON.stringify(body),
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  if (r.statusCode !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

async function apiGet(path) {
  const jwt = await getJwt();
  if (!jwt) return null;
  const { gotScraping } = await import('got-scraping');
  const r = await gotScraping.get(`${API_BASE}${path}`, {
    headers: {
      'User-Agent': UA, 'Accept': 'application/json',
      'Authorization': `Bearer ${jwt}`,
      'X-Client-Info': JSON.stringify({ timezone: 'UTC' }),
      'X-Request-Lang': 'en',
    },
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  if (r.statusCode !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

export class MovieBox extends Source {
  constructor(fetcher) {
    super();
    this.id = 'moviebox';
    this.label = 'MovieBox';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = SITE_BASE;
    this.fetcher = fetcher;
    // MovieBox doesn't have anime-specific content — it's all movies/series
    // Stream URLs are time-limited, so use short cache TTL
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search for the title
    const subjectType = tmdbId.season ? 2 : 1; // 1=movie, 2=series
    const item = await this.findItem(name, year, subjectType);
    if (!item) return [];

    // Step 2: Get play URLs
    const se = tmdbId.season || 0;
    const ep = tmdbId.episode || 0;
    const playData = await apiGet(
      `/subject/play?subjectId=${item.subjectId}&se=${se}&ep=${ep}&detailPath=${item.detailPath}&streamSignType=1`
    );

    // Note: The /subject/play endpoint requires a Referer header
    // We need to re-fetch with the correct Referer
    if (!playData?.data?.streams?.length) {
      // Retry with Referer
      const jwt = await getJwt();
      if (!jwt) return [];
      const { gotScraping } = await import('got-scraping');
      const r = await gotScraping.get(
        `${API_BASE}/subject/play?subjectId=${item.subjectId}&se=${se}&ep=${ep}&detailPath=${item.detailPath}&streamSignType=1`,
        {
          headers: {
            'User-Agent': UA, 'Accept': 'application/json',
            'Authorization': `Bearer ${jwt}`,
            'Referer': `${SITE_BASE}/movies/${item.detailPath}`,
          },
          timeout: { request: 15000 }, throwHttpErrors: false,
        }
      );
      if (r.statusCode !== 200) return [];
      try {
        const data = JSON.parse(r.body);
        if (!data?.data?.streams?.length) return [];
        return this.buildStreams(data.data.streams, title);
      } catch { return []; }
    }

    return this.buildStreams(playData.data.streams, title);
  }

  buildStreams(streams, title) {
    const results = [];
    const seenUrls = new Set();

    for (const s of streams) {
      if (!s.url || s.vipLocked) continue;
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);

      let parsed;
      try { parsed = new URL(s.url); } catch { continue; }

      const height = parseInt(s.resolutions) || undefined;

      // hakunaymatata.com CDN returns 429 (Too Many Requests) when accessed
      // without a Referer. Route through /proxy with movie-box.co Referer to
      // avoid the rate limit.
      const requestHeaders = parsed.hostname.endsWith('.hakunaymatata.com')
        ? { Referer: 'https://movie-box.co/' }
        : undefined;

      results.push({
        url: parsed,
        format: Format.mp4,
        ...(requestHeaders && { requestHeaders }),
        meta: {
          countryCodes: [CountryCode.multi],
          title: `${title} (${s.resolutions}p)`,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
        },
      });
    }

    return results;
  }

  // Search MovieBox by name and return the best matching item
  async findItem(name, year, subjectType) {
    const nameNorm = normalize(name);
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      const data = await apiPost('/subject/search', {
        keyword: query, page: 1, perPage: 20, subjectType,
      });
      if (!data?.data?.items?.length) continue;

      let best = null;
      let bestScore = 0;
      for (const item of data.data.items) {
        if (item.subjectType !== subjectType) continue;
        const itemNorm = normalize(item.title);
        if (!itemNorm) continue;

        let score = 0;
        if (itemNorm === nameNorm) score = 100;
        else if (itemNorm.includes(nameNorm) || nameNorm.includes(itemNorm)) {
          score = Math.min(itemNorm.length, nameNorm.length) / Math.max(itemNorm.length, nameNorm.length) * 90;
        }

        // Year bonus — helps distinguish remakes/sequels
        if (score > 0 && year && item.releaseDate) {
          const itemYear = parseInt(item.releaseDate.slice(0, 4));
          if (itemYear === year) score += 10;
        }

        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }

      if (best && bestScore >= 60) return best;
    }

    return null;
  }
}
