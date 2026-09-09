// src/utils/animeIdResolver.js
// Shared anime ID resolver with multiple fallback strategies.
//
// When AniList API is down (403 "temporarily disabled"), we fall back to
// the Jikan API (MyAnimeList wrapper) to resolve anime IDs by title.
//
// Supported ID types:
//   - AniList ID (used by anichan, itachi, animesuge, etc.)
//   - MAL ID (used by 2dhive, antova, etc.)
//
// Resolution chain:
//   1. Try AniList GraphQL (fast, returns AniList ID + romaji title)
//   2. If AniList fails, try Jikan API (returns MAL ID + titles)
//   3. If Jikan returns MAL ID, try to convert to AniList ID via AniList's
//      /media lookup by idMal (may fail if AniList is fully down)
//
// Usage:
//   import { resolveAnimeId } from '../utils/animeIdResolver.js';
//   const { anilistId, malId, title, romaji } = await resolveAnimeId(name, year);

const ANILIST_GQL = 'https://graphql.anilist.co';
const JIKAN_API = 'https://api.jikan.moe/v4';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Cache: title → { anilistId, malId, title, romaji, timestamp }
const idCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Resolve anime IDs by title using AniList first, then Jikan fallback.
 *
 * @param {string} name - Anime title (English or Romaji)
 * @param {number|string} [year] - Release year (optional, for better matching)
 * @returns {Promise<{anilistId: string|null, malId: string|null, title: string, romaji: string|null}>}
 */
export async function resolveAnimeId(name, year) {
  if (!name) return { anilistId: null, malId: null, title: name || '', romaji: null };

  const cacheKey = `${name.toLowerCase()}_${year || ''}`;
  const cached = idCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  let result = { anilistId: null, malId: null, title: name, romaji: null };

  // Strategy 1: Try AniList GraphQL
  try {
    const anilistResult = await resolveViaAniList(name);
    if (anilistResult) {
      result = anilistResult;
      // If we got an AniList ID but no MAL ID, try to get MAL ID too
      if (result.anilistId && !result.malId) {
        // AniList response includes idMal — extract it if available
        // (already handled in resolveViaAniList)
      }
      idCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }
  } catch {
    // AniList is down — fall through to Jikan
  }

  // Strategy 2: Try Jikan API (MyAnimeList wrapper)
  try {
    const jikanResult = await resolveViaJikan(name, year);
    if (jikanResult) {
      result = jikanResult;
      // If we got a MAL ID but no AniList ID, try to convert
      if (result.malId && !result.anilistId) {
        const alId = await malToAniList(result.malId);
        if (alId) result.anilistId = alId;
      }
    }
  } catch {
    // Both APIs failed
  }

  // Strategy 3: Try Kitsu API (when both AniList and Jikan are down)
  if (!result.anilistId && !result.malId) {
    try {
      const kitsuResult = await resolveViaKitsu(name, year);
      if (kitsuResult) {
        result = kitsuResult;
      }
    } catch {
      // All three APIs failed
    }
  }

  idCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Resolve via AniList GraphQL API.
 * Returns { anilistId, malId, title, romaji } or null on failure.
 */
async function resolveViaAniList(name) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 5) {
        media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id
          idMal
          title { romaji english }
          format
        }
      }
    }`;

  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.post(ANILIST_GQL, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: { search: name } }),
    timeout: { request: 10000 },
    throwHttpErrors: false,
    http2: false,
  });

  if (res.statusCode !== 200) return null;
  const data = JSON.parse(res.body);
  const media = data?.data?.Page?.media;
  if (!media || media.length === 0) return null;

  // Pick the best match
  const best = media[0];
  return {
    anilistId: String(best.id),
    malId: best.idMal ? String(best.idMal) : null,
    title: best.title?.english || best.title?.romaji || name,
    romaji: best.title?.romaji || null,
  };
}

/**
 * Resolve via Jikan API (MyAnimeList wrapper).
 * Returns { anilistId, malId, title, romaji } or null on failure.
 */
async function resolveViaJikan(name, year) {
  const searchUrl = `${JIKAN_API}/anime?q=${encodeURIComponent(name)}&limit=5&sfw=true`;
  const res = await fetch(searchUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.data;
  if (!Array.isArray(results) || results.length === 0) return null;

  // Pick the best match — prefer TV type and year match
  let best = results[0];
  let bestScore = -1;
  for (const r of results) {
    let score = 0;
    // Prefer TV type (most anime we search for are TV series)
    if (r.type === 'TV') score += 3;
    if (r.type === 'Movie') score += 2;
    // Year match
    const rYear = r.aired?.from ? new Date(r.aired.from).getFullYear() : null;
    if (year && rYear && String(year) === String(rYear)) score += 5;
    // Title similarity
    const titleEn = r.title_english || r.title;
    if (titleEn && titleEn.toLowerCase() === name.toLowerCase()) score += 4;
    else if (titleEn && titleEn.toLowerCase().includes(name.toLowerCase())) score += 2;
    if (score > bestScore) { bestScore = score; best = r; }
  }

  return {
    anilistId: null, // Will be resolved by malToAniList if needed
    malId: String(best.mal_id),
    title: best.title_english || best.title || name,
    romaji: best.title_japanese || best.title || null,
  };
}

/**
 * Resolve via Kitsu API.
 * Returns { anilistId, malId, title, romaji } or null on failure.
 * Kitsu doesn't return AniList or MAL IDs, but returns the title which
 * can be used for site-specific search.
 */
async function resolveViaKitsu(name, year) {
  const searchUrl = `${JIKAN_API.replace('jikan.moe/v4', 'kitsu.app/api/edge')}/anime?filter[text]=${encodeURIComponent(name)}&page[limit]=5`;
  const res = await fetch(searchUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/vnd.api+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.data;
  if (!Array.isArray(results) || results.length === 0) return null;

  // Pick the best match — prefer TV type and year match
  let best = results[0];
  let bestScore = -1;
  for (const r of results) {
    let score = 0;
    const attrs = r.attributes || {};
    if (attrs.subtype === 'TV') score += 3;
    if (attrs.subtype === 'movie') score += 2;
    const rYear = attrs.startDate ? new Date(attrs.startDate).getFullYear() : null;
    if (year && rYear && String(year) === String(rYear)) score += 5;
    const titleEn = attrs.titles?.en || attrs.canonicalTitle;
    if (titleEn && titleEn.toLowerCase() === name.toLowerCase()) score += 4;
    else if (titleEn && titleEn.toLowerCase().includes(name.toLowerCase())) score += 2;
    if (score > bestScore) { bestScore = score; best = r; }
  }

  const attrs = best.attributes || {};
  return {
    anilistId: null, // Kitsu doesn't provide AniList IDs
    malId: null, // Kitsu doesn't provide MAL IDs directly
    kitsuId: String(best.id), // Kitsu ID — some sites accept this
    title: attrs.titles?.en || attrs.canonicalTitle || name,
    romaji: attrs.titles?.ja_jp || attrs.canonicalTitle || null,
  };
}

/**
 * Convert MAL ID to AniList ID using AniList's API.
 * Returns the AniList ID or null if conversion fails.
 */
async function malToAniList(malId) {
  const query = `
    query($idMal: Int) {
      Media(type: ANIME, idMal: $idMal) {
        id
      }
    }`;
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping.post(ANILIST_GQL, {
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { idMal: parseInt(malId) } }),
      timeout: { request: 8000 },
      throwHttpErrors: false,
      http2: false,
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    const id = data?.data?.Media?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * Check if AniList API is currently available.
 * @returns {Promise<boolean>}
 */
export async function isAniListAvailable() {
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping.post(ANILIST_GQL, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query: '{ Page(page:1, perPage:1) { media(type:ANIME) { id } } }' }),
      timeout: { request: 5000 },
      throwHttpErrors: false,
      http2: false,
    });
    return res.statusCode === 200;
  } catch {
    return false;
  }
}
