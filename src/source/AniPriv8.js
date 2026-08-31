// src/source/AniPriv8.js
// anipriv8.online — anime with sub/dub via AniPriv8 pipeline API
//
// Flow:
//   1. Resolve AniList ID via AniList GraphQL search by name
//   2. GET /api/secure/pipeline/{provider}/soft-subs/{anilistId}/{ep}/{sub|dub}
//      providers: anikuro, anidap, 4animo, animeheaven, anidb
//   3. Response: { streams: [{ quality, type: "hls", url: "/api/secure/pipeline/{token}" }] }
//   4. The token URL returns a valid HLS m3u8 playlist (relative segment URLs)
//   5. Route through /proxy with m3u8 URL rewriting (relative → absolute /proxy URLs)
//
// Both sub and dub supported. No auth, no CF, no Referer needed.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const API_BASE = 'https://anipriv8.online';
const ANILIST_GQL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Only use anikuro (primary, fastest) and animeheaven (MP4 fallback).
// Other providers are slow or return errors.
const PROVIDERS = ['anikuro', 'animeheaven'];

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function apiGet(path) {
  const { gotScraping } = await import('got-scraping');
  try {
    const res = await gotScraping.get(`${API_BASE}${path}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: { request: 30000 },
      throwHttpErrors: false,
      followRedirect: true,
    });
    if (res.statusCode !== 200) return null;
    try { return JSON.parse(res.body); } catch { return null; }
  } catch { return null; }
}

async function resolveAniList(name) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 5) {
        media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id idMal title { romaji english } format
        }
      }
    }`;
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping.post(ANILIST_GQL, {
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { search: name } }),
      timeout: { request: 15000 }, throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    return data?.data?.Page?.media || [];
  } catch { return null; }
}

export class AniPriv8 extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anipriv8';
    this.label = 'AniPriv8';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = API_BASE;
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — tokens may expire
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Resolve AniList ID
    const mediaList = await resolveAniList(name);
    if (!mediaList?.length) return [];

    const nameNorm = normalize(name);
    let bestMedia = null;
    let bestScore = 0;
    for (const m of mediaList) {
      const titles = [m.title?.english, m.title?.romaji].filter(Boolean);
      for (const t of titles) {
        const tNorm = normalize(t);
        if (!tNorm) continue;
        let score = 0;
        if (tNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        }
        if (score > bestScore) { bestScore = score; bestMedia = m; }
      }
    }
    if (!bestMedia || bestScore < 60) return [];

    const anilistId = bestMedia.id;
    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;

    // Step 2: Fetch streams from all providers, both sub and dub
    const results = [];
    const seenUrls = new Set();

    for (const provider of PROVIDERS) {
      for (const audio of ['sub', 'dub']) {
        const data = await apiGet(`/api/secure/pipeline/${provider}/soft-subs/${anilistId}/${epNum}/${audio}`);
        if (!data?.streams?.length) continue;

        for (const stream of data.streams) {
          if (!stream.url || stream.type !== 'hls') continue;

          const fullUrl = stream.url.startsWith('http') ? stream.url : `${API_BASE}${stream.url}`;
          if (seenUrls.has(fullUrl)) continue;
          seenUrls.add(fullUrl);

          // Return the DIRECT stream URL — the proxy will detect it as HLS
          // by checking the response body for #EXTM3U.
          // The m3u8 has relative segment URLs (/api/secure/pipeline/{token})
          // that the proxy rewrites to absolute /proxy URLs.
          let parsed;
          try { parsed = new URL(fullUrl); } catch { continue; }

          const audioLabel = audio === 'dub' ? 'Dub' : 'Sub';
          const countryCodes = audio === 'dub'
            ? [CountryCode.multi, CountryCode.en]
            : [CountryCode.multi, CountryCode.ja];

          results.push({
            url: parsed,
            format: Format.hls,
            meta: {
              countryCodes,
              title: `${title} (${audioLabel} · ${provider} · ${stream.quality || 'HD'})`,
              sourceId: this.id,
              sourceLabel: this.label,
            },
          });
        }
      }
    }

    return results;
  }
}
