// src/source/Itachi.js
// itachi.tv — anime-only portal with sub+dub multi-audio + multi-language subtitles
//
// itachi.tv is a Next.js SPA that wraps 5 underlying embed providers:
//   1. anilink.cc  — PoW challenge (skipped — too complex for server-side)
//   2. vidhawk.buzz — clean REST API (PRIMARY — see below)
//   3. megaplay.buzz — already handled by Megaplay extractor
//   4. vidnest.fun — multi-backend SPA (skipped — needs browser JS)
//   5. dropfile.cc — appears dead (no response)
//
// Plus an availability API:
//   GET https://itachi.tv/api/playback/availability?anilistId=X&episodeNumber=Y&language=sub|dub&providerId=Z
//   → { available: true, providerId, reason }
//
// ===== VidHawk Flow (PRIMARY) =====
// VidHawk exposes a clean public REST API:
//   1. GET /api/stream/resolve?anilistId={alId}&episode={ep}&server={srv}&variant={sub|dub}&skipMapper=1&parentHost=itachi.tv
//      → { ticket, server, defaultAudio, servers: [{id,label,category}] }
//   2. GET /api/play?t={ticket}
//      → { tracks: [{id:"sub",label:"Sub",src:"https://edge.vidhawk.buzz/hls.m3u8?t=..."},
//                   {id:"dub",label:"Dub",src:"https://edge.vidhawk.buzz/hls.m3u8?t=..."}],
//          captions: { sub: [{src,label,lang}], dub: [{src,label,lang}] },
//          intro: {start,end}, outro: {start,end} }
//
// 6 servers available: kari, flow, melo (regular) + core, gojo, zuri (hsub — hardcoded subs, sub-only)
// We probe the 3 regular servers × 2 audio variants = 6 streams per episode
// (each stream has its own subtitle track from VidHawk's captions response).
//
// HLS streams on edge.vidhawk.buzz are PUBLIC — no Referer needed. Stremio plays
// them directly via HLS with Range support.
//
// ===== MegaPlay Flow (SECONDARY) =====
// MegaPlay URLs are deterministic:
//   https://megaplay.buzz/stream/ani/{anilistId}/{episode}/{sub|dub}
// The Megaplay extractor resolves these via the getSourcesNew API. We emit
// 2 MegaPlay URLs (sub + dub) as additional fallback streams.
//
// ===== TMDB → AniList ID =====
// AniList GraphQL search by name:
//   POST https://graphql.anilist.co
//   query: search by name, return {id, idMal, title{romaji,english}, format, episodes}
//
// ===== Anime-only filter =====
// Itachi is anime-only. We hard-filter:
//   - Skip if TMDB doesn't have "Animation" genre AND original_language isn't 'ja'
//   - Skip if AniList match score < 75 (prevents false matches)
//   - Skip if AniList format doesn't match request type (movie vs TV)

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const ITACHI_BASE = 'https://itachi.tv';
const VIDHAWK_BASE = 'https://vidhawk.buzz';
const ANILIST_GQL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 3 regular VidHawk servers (each supports both sub + dub)
const VIDHAWK_SERVERS = [
  { id: 'kari', label: 'Kari' },
  { id: 'flow', label: 'Flow' },
  { id: 'melo', label: 'Melo' },
];

// AniList formats that count as real anime (NOT music videos, novels, etc.)
const VALID_MOVIE_FORMATS = new Set(['MOVIE']);
const VALID_SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL']);

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function gotGet(url, headers = {}, timeoutMs = 12000) {
  const { gotScraping } = await import('got-scraping');
  return gotScraping.get(url, {
    headers: { 'User-Agent': UA, ...headers },
    timeout: { request: timeoutMs },
    throwHttpErrors: false,
    followRedirect: true,
  });
}

async function gotJson(url, headers = {}, timeoutMs = 12000) {
  const res = await gotGet(url, headers, timeoutMs);
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

async function gotPost(url, body, headers = {}, timeoutMs = 12000) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.post(url, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    timeout: { request: timeoutMs },
    throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// Check if TMDB content is actually anime (Animation genre or Japanese origin)
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c');
    const data = await fetcher.json(ctx, url);
    if (!data) return false;

    const genres = data.genres || [];
    if (genres.some(g => g.id === 16)) return true; // Animation genre
    if (data.original_language === 'ja') return true; // Japanese origin
    return false;
  } catch {
    // If TMDB fetch fails, be permissive (don't block anime that might work)
    return true;
  }
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
    const data = await gotPost(ANILIST_GQL,
      { query, variables: { search: name } },
      { Accept: 'application/json' },
      15000);
    return data?.data?.Page?.media || [];
  } catch { return []; }
}

// Pick best AniList match — must match format (movie vs series) and have score >= 75
function pickBestAniList(mediaList, name, wantMovie) {
  const allowedFormats = wantMovie ? VALID_MOVIE_FORMATS : VALID_SERIES_FORMATS;
  const nameNorm = normalize(name);
  let best = null;
  let bestScore = 0;
  for (const m of mediaList) {
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
      if (score > bestScore) { bestScore = score; best = m; }
    }
  }
  if (!best || bestScore < 75) return null;
  return best;
}

// Fetch a VidHawk ticket for a specific server + variant
// Pass malId when available — speeds up VidHawk's lookup and is required
// for some titles (e.g. "Your Name." needs malId=32281, not just anilistId)
async function resolveVidHawkTicket(anilistId, malId, episode, serverId, variant) {
  const params = new URLSearchParams({
    anilistId: String(anilistId),
    episode: String(episode),
    server: serverId,
    variant,
    parentHost: 'itachi.tv',
  });
  if (malId) {
    params.set('malId', String(malId));
  }
  const url = `${VIDHAWK_BASE}/api/stream/resolve?${params.toString()}`;
  return gotJson(url, { Referer: `${VIDHAWK_BASE}/` }, 10000);
}

// Fetch play data (tracks + captions) for a ticket
async function fetchVidHawkPlay(ticket) {
  const url = `${VIDHAWK_BASE}/api/play?t=${encodeURIComponent(ticket)}`;
  return gotJson(url, { Referer: `${VIDHAWK_BASE}/` }, 10000);
}

// Detect resolution from HLS playlist (best-effort — non-blocking on failure)
async function detectHlsHeight(hlsUrl) {
  try {
    const res = await gotGet(hlsUrl, {}, 8000);
    if (res.statusCode !== 200) return undefined;
    const m = res.body.match(/RESOLUTION=\d+x(\d+)/i);
    return m ? parseInt(m[1], 10) : undefined;
  } catch { return undefined; }
}

// Check if a (provider, variant) is available via itachi.tv's availability API
async function checkAvailability(anilistId, episode, language, providerId) {
  try {
    const url = `${ITACHI_BASE}/api/playback/availability?anilistId=${anilistId}&episodeNumber=${episode}&language=${language}&providerId=${providerId}`;
    const data = await gotJson(url, { Referer: `${ITACHI_BASE}/` }, 6000);
    return !!(data?.available);
  } catch { return false; }
}

export class Itachi extends Source {
  constructor(fetcher) {
    super();
    this.id = 'itachi';
    this.label = 'Itachi';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = ITACHI_BASE;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Anime-only — hard filter
    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);
    if (!isAnime) return [];

    // Resolve AniList ID
    const wantMovie = !tmdbId.season;
    const mediaList = await resolveAniList(name);
    if (!mediaList?.length) return [];

    const best = pickBestAniList(mediaList, name, wantMovie);
    if (!best) return [];

    const anilistId = best.id;
    const malId = best.idMal;
    const epNum = wantMovie ? 1 : (tmdbId.episode || 1);

    const results = [];
    const seenHls = new Set();

    // ===== VidHawk: 3 servers × 2 audio variants = up to 6 streams =====
    // Probe each server in parallel — each returns one ticket → 2 tracks (sub+dub)
    const vidhawkPromises = VIDHAWK_SERVERS.map(async (server) => {
      try {
        const resolveData = await resolveVidHawkTicket(anilistId, malId, epNum, server.id, 'sub');
        if (!resolveData?.ticket) return [];

        const playData = await fetchVidHawkPlay(resolveData.ticket);
        if (!playData?.tracks) return [];

        const streams = [];
        for (const track of playData.tracks) {
          if (!track?.src) continue;
          let trackUrl;
          try { trackUrl = new URL(track.src); } catch { continue; }

          // Dedup by HLS URL (VidHawk may return same URL across servers)
          if (seenHls.has(trackUrl.href)) continue;

          // Build subtitles from captions for this audio variant
          // VidHawk subtitle URLs (edge.vidhawk.buzz/sub.vtt) require a Referer
          // header — route through /proxy so Stremio can fetch them.
          const proxyBase = ctx.hostUrl ? new URL('/proxy', ctx.hostUrl) : null;
          const captions = (playData.captions?.[track.id] || [])
            .map(c => {
              try { new URL(c.src); return c; } catch { return null; }
            })
            .filter(Boolean)
            .map(c => {
              let subUrl = c.src;
              if (proxyBase) {
                const p = new URL(proxyBase.href);
                p.searchParams.set('url', c.src);
                p.searchParams.set('referer', 'https://vidhawk.buzz/');
                subUrl = p.href;
              }
              return {
                id: c.lang || c.label || track.id,
                url: subUrl,
                lang: c.lang || 'en',
                label: c.label || 'English',
              };
            });

          const isDub = track.id === 'dub';
          const countryCodes = isDub
            ? [CountryCode.multi, CountryCode.en]
            : [CountryCode.multi, CountryCode.ja];

          const audioLabel = isDub ? 'English (DUB)' : 'Japanese (SUB)';

          streams.push({
            url: trackUrl,
            format: Format.hls,
            meta: {
              countryCodes,
              title: `${titleBase} — [Itachi VidHawk ${server.label}] ${audioLabel}`,
              sourceId: this.id,
              sourceLabel: this.label,
              serverName: `${server.label} ${isDub ? 'DUB' : 'SUB'}`,
              audioLabel: isDub ? 'English' : 'Japanese',
              sourceType: 'WebDL',
              codec: 'x264',
              ...(captions.length > 0 && { subtitles: captions }),
            },
          });
          seenHls.add(trackUrl.href);
        }
        return streams;
      } catch {
        return [];
      }
    });

    // Wait for all VidHawk servers in parallel (with 15s overall budget)
    try {
      const vidhawkResults = await Promise.race([
        Promise.all(vidhawkPromises),
        new Promise(resolve => setTimeout(() => resolve([]), 18000)),
      ]);
      for (const streams of vidhawkResults) {
        if (Array.isArray(streams)) results.push(...streams);
      }
    } catch { /* fall through to MegaPlay */ }

    // ===== MegaPlay: 2 URLs (sub + dub) — handled by Megaplay extractor =====
    // These are deterministic URLs — no API call needed. The Megaplay extractor
    // claims them and resolves via getSourcesNew.
    for (const subDub of ['sub', 'dub']) {
      const megaUrl = `https://megaplay.buzz/stream/ani/${anilistId}/${epNum}/${subDub}`;
      try {
        const parsed = new URL(megaUrl);
        const isDub = subDub === 'dub';
        const countryCodes = isDub
          ? [CountryCode.multi, CountryCode.en]
          : [CountryCode.multi, CountryCode.ja];
        const audioLabel = isDub ? 'English (DUB)' : 'Japanese (SUB)';

        results.push({
          url: parsed,
          format: Format.hls,
          meta: {
            countryCodes,
            title: `${titleBase} — [Itachi MegaPlay] ${audioLabel}`,
            sourceId: this.id,
            sourceLabel: this.label,
            serverName: `MegaPlay ${subDub.toUpperCase()}`,
            audioLabel: isDub ? 'English' : 'Japanese',
            sourceType: 'WebDL',
            codec: 'x264',
          },
        });
      } catch { /* skip invalid URL */ }
    }

    // Best-effort: detect height for the first VidHawk stream (enrich metadata)
    // Doing this for every stream would be too slow (extra HTTP per stream).
    // VidHawk typically serves 720p-1080p; default to 1080p.
    for (const r of results) {
      if (!r.meta.height) r.meta.height = 1080;
    }

    console.log(`[itachi] ${results.length} stream(s) for anilistId=${anilistId} ep=${epNum}`);
    return results;
  }
}
