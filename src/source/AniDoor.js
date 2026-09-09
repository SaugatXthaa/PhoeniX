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

// Resolve AniList ID + MAL ID via AniList GraphQL search by name.
async function resolveAniList(name) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 10) {
        media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id
          idMal
          title { romaji english native userPreferred }
          format
          episodes
          duration
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
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      const media = data?.data?.Page?.media || [];
      if (media.length > 0) return media;
    }
  } catch { /* AniList might be down — fall through to Jikan */ }

  // Fallback: Jikan API (MyAnimeList wrapper) — returns MAL IDs
  try {
    const jikanUrl = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(name)}&limit=5&sfw=true`;
    const res = await fetch(jikanUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const jikanData = await res.json();
      const results = jikanData?.data || [];
      if (results.length > 0) {
        // Convert Jikan results to AniList-like shape (id: null — will use MAL ID)
        return results.map(r => ({
          id: null,
          idMal: r.mal_id,
          title: { romaji: r.title_japanese || r.title, english: r.title_english || r.title, userPreferred: r.title },
          format: r.type === 'TV' ? 'TV' : r.type === 'MOVIE' ? 'MOVIE' : 'TV',
          episodes: r.episodes,
          duration: r.duration,
        }));
      }
    }
  } catch { /* fall through to Kitsu */ }

  // Fallback: Kitsu API — no AniList/MAL IDs, but lets us match the title
  try {
    const kitsuUrl = `https://kitsu.app/api/edge/anime?filter[text]=${encodeURIComponent(name)}&page[limit]=5`;
    const res = await fetch(kitsuUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const kitsuData = await res.json();
      const results = kitsuData?.data || [];
      if (results.length > 0) {
        return results.map(r => ({
          id: null,
          idMal: null, // Kitsu doesn't expose MAL IDs in this endpoint
          title: {
            romaji: r.attributes?.titles?.en_jp || r.attributes?.canonicalTitle,
            english: r.attributes?.titles?.en || r.attributes?.canonicalTitle,
            userPreferred: r.attributes?.canonicalTitle,
          },
          format: (r.attributes?.subtype === 'movie') ? 'MOVIE' : 'TV',
          episodes: r.attributes?.episodeCount,
          duration: r.attributes?.episodeLength,
        }));
      }
    }
  } catch { /* give up */ }

  return [];
}

// AniList formats that count as real anime episodes/movies — NOT music videos.
// MUSIC = promotional music video, NOVEL = text-only release, etc.
// These get filtered out because megaplay.buzz has no real stream for them.
const VALID_MOVIE_FORMATS = new Set(['MOVIE']);
const VALID_SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL']);

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

    // The Stremio request type tells us which AniList format we should accept.
    // - tmdbId.season present → user wants a TV episode → only match series-format anime
    // - no season → user wants a movie → only match MOVIE-format anime
    // This prevents AniDoor from emitting anime streams for non-anime content
    // (e.g. "Supergirl (2026)" the DC movie → would otherwise match the
    // "SUPERGIRL" AniList entry which is a 3-min MUSIC video).
    const wantMovie = !tmdbId.season;
    const allowedFormats = wantMovie ? VALID_MOVIE_FORMATS : VALID_SERIES_FORMATS;

    // Step 1: Resolve AniList ID + MAL ID via AniList GraphQL search
    const mediaList = await resolveAniList(name);
    if (!mediaList?.length) return [];

    // Find best match by title — but ONLY among entries whose format matches
    // the user's request type. This is the key fix that stops AniDoor from
    // matching a music video when the user is watching a movie, or matching
    // a TV anime when the user is watching a movie (and vice versa).
    const nameNorm = normalize(name);
    let bestMedia = null;
    let bestScore = 0;
    for (const m of mediaList) {
      // Hard filter: skip formats that don't match the request type
      if (!allowedFormats.has(m.format)) continue;

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
    // Raised threshold from 60 → 75: a 60-score "includes" match is too loose
    // and causes false positives on titles like "Supergirl" ↔ "SUPERGIRL" (music
    // video) when the real anime has a different romaji title.
    if (!bestMedia || bestScore < 75) return [];

    const anilistId = bestMedia.id;
    const malId = bestMedia.idMal;
    // If neither ID is available (rare Jikan/Kitsu edge case), can't build URLs
    if (!anilistId && !malId) return [];
    const isMovie = wantMovie;

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

      // Some templates use {al} (AniList ID) — skip if Jikan/Kitsu fallback
      // gave us no AniList ID (only MAL ID is available)
      if (src.path.includes('{al}') && !anilistId) continue;

      // Skip dead/unextractable hosts — only megaplay.buzz URLs can be
      // resolved server-side (via the Megaplay extractor's getSourcesNew API).
      // vidnest.fun is a Next.js SPA (client-side fetch only).
      // tryembed.us.cc requires a nonce/session handshake.
      // stream.nightslayer.workers.dev returns 404 "Content Not Available".
      // dropfile.cc is connection-refused / down.
      if (!src.base.includes('megaplay.buzz')) continue;

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
