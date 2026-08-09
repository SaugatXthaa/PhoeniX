// src/source/AniDoor.js
// anidoor.me — anime-only portal with PUBLIC sources.json config
//
// AniDoor is a pure SPA that uses AniList GraphQL for metadata and a public
// `sources.json` config for embed URL templates. The embed URLs are 100%
// deterministic from the AniList ID (+ MAL ID for some hosts) + episode num.
//
// Flow:
//   1. Resolve AniList ID via AniList GraphQL search by name
//      POST https://graphql.anilist.co
//      → {data:{Page:{media:[{id, idMal, title:{english,romaji}}]}}}
//   2. For each embed template in sources.json, substitute {al}/{mal}/{e}
//      and build both sub and dub URLs
//   3. Return all embed URLs — the Megaplay extractor claims megaplay.buzz URLs
//      and resolves them to direct m3u8 via getSourcesNew
//
// Embed hosts (from sources.json):
//   - megaplay.buzz/stream/ani/{al}/{e}/{sub|dub}        ← Megaplay extractor
//   - megaplay.buzz/stream/mal/{mal}/{e}/{sub|dub}       ← Megaplay extractor
//   - vidnest.fun/anime/{al}/{e}/{sub|dub}               ← claimed by VidKing fallback
//   - vidnest.fun/animepahe/{al}/{e}/{sub|dub}           ← claimed by VidKing fallback
//   - tryembed.us.cc/embed/anime/{al}/{e}/{sub|dub}      ← ExternalUrl fallback
//
// Only megaplay.buzz URLs are reliably resolvable server-side. VidNest and
// TryEmbed require client-side JS execution. We emit all of them so Stremio
// can fall through to ExternalUrl if extraction fails.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://anidoor.me';
const SOURCES_JSON_URL = 'https://anidoor.me/assets/sources.json';
const ANILIST_GQL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// Cache sources.json (it changes occasionally — refresh every 24h)
let sourcesCache = null;
let sourcesCacheTs = 0;
const SOURCES_TTL = 24 * 60 * 60 * 1000;

async function fetchSourcesJson() {
  if (sourcesCache && Date.now() - sourcesCacheTs < SOURCES_TTL) return sourcesCache;
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping.get(SOURCES_JSON_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: { request: 10000 },
      throwHttpErrors: false,
    });
    if (res.statusCode === 200) {
      sourcesCache = JSON.parse(res.body);
      sourcesCacheTs = Date.now();
      return sourcesCache;
    }
  } catch { /* fall through to hardcoded fallback */ }
  return null;
}

// Resolve AniList ID + MAL ID via AniList GraphQL search by name
async function resolveAniList(name) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 10) {
        media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id
          idMal
          title { romaji english native userPreferred }
          format
        }
      }
    }`;
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping.post(ANILIST_GQL, {
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables: { search: name } }),
      timeout: { request: 15000 },
      throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    return data?.data?.Page?.media || [];
  } catch { return null; }
}

export class AniDoor extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anidoor';
    this.label = 'AniDoor';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Resolve AniList ID + MAL ID via AniList GraphQL search
    const mediaList = await resolveAniList(name);
    if (!mediaList?.length) return [];

    // Find best match by title
    const nameNorm = normalize(name);
    let bestMedia = null;
    let bestScore = 0;
    for (const m of mediaList) {
      const titles = [m.title?.english, m.title?.romaji, m.title?.userPreferred].filter(Boolean);
      for (const t of titles) {
        const tNorm = normalize(t);
        if (!tNorm) continue;
        let score = 0;
        if (tNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMedia = m;
        }
      }
    }
    if (!bestMedia || bestScore < 0.6) return [];

    const anilistId = bestMedia.id;
    const malId = bestMedia.idMal;
    const isMovie = bestMedia.format === 'MOVIE';

    // Step 2: Fetch sources.json config
    const sources = await fetchSourcesJson();
    if (!Array.isArray(sources) || sources.length === 0) return [];

    // Step 3: Build embed URLs from each template
    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const results = [];
    const seenUrls = new Set();

    for (const src of sources) {
      // Skip sources that don't match the content type
      // (movies use type:"movie", series use type:"anime")
      if (isMovie && src.type !== 'movie') continue;
      if (!isMovie && src.type !== 'anime') continue;

      // Some templates use {mal} — skip if we don't have a MAL ID
      if (src.path.includes('{mal}') && !malId) continue;

      // Build URL by substituting placeholders
      const subDub = src.dub ? 'dub' : 'sub';
      const url = src.base + src.path
        .replace('{al}', anilistId)
        .replace('{mal}', malId || '')
        .replace('{s}', '1')
        .replace('{e}', epNum);

      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      const audioLabel = subDub === 'dub' ? 'Dub' : 'Sub';
      const countryCodes = subDub === 'dub'
        ? [CountryCode.multi, CountryCode.en]
        : [CountryCode.multi, CountryCode.ja];

      const srcName = src.name || src.id || src.base.split('//')[1]?.split('/')[0];

      results.push({
        url: new URL(url),
        meta: {
          countryCodes,
          title: `${title} (${audioLabel} · ${srcName})`,
          sourceId: this.id,
          sourceLabel: this.label,
        },
      });
    }

    return results;
  }
}
