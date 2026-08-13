// src/source/AniChan.js
// anichan.net — anime with sub/dub HLS streams (up to 1080p)
//
// AniChan uses AniList IDs and a clean JSON API:
//   1. Search: GET /search?q={query} → HTML with /anime/{anilistId}/{slug} links
//   2. Episodes: GET /api/watch/episodes?anilistId={id}
//      → { episodes: N, sources: [{name, host, sub: bool, dub: bool}], dubAvailable: bool }
//   3. Servers: GET /api/watch/servers?anilistId={id}&episode={ep}&type={sub|dub}
//      → { servers: [{name, label, host, type: "hls", stream: "/api/watch/m3u8?sh=...", subtitles: [...]}] }
//   4. Stream: GET /api/watch/m3u8?sh={path}&sig={sig}&exp={exp}
//      → HLS master m3u8 with relative variant URLs (also /api/watch/m3u8?sh=...)
//
// The m3u8 has RELATIVE URLs (/api/watch/m3u8?sh=...) that must be resolved
// against anichan.net. Stremio's player can't resolve these, so we route
// through /proxy. The proxy buffers the m3u8, detects #EXTM3U, rewrites
// relative URLs to absolute /proxy URLs, and serves with correct Content-Type.
//
// Both SUB (Japanese audio) and DUB (English audio) are supported.
// The API returns the same stream for sub/dub when dub is not available —
// we deduplicate by URL so only one stream appears.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE = 'https://anichan.net';
const ANILIST_GQL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function apiGet(path) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(`${BASE}${path}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: { request: 15000 },
    throwHttpErrors: false,
    followRedirect: true,
    http2: false, // Avoid GOAWAY errors from AniChan's HTTP/2 server
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
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
      http2: false, // Avoid GOAWAY errors
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    return data?.data?.Page?.media || [];
  } catch { return null; }
}

export class AniChan extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anichan';
    this.label = 'AniChan';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = BASE;
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream URLs have time-limited tokens
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Resolve AniList ID
    const mediaList = await resolveAniList(name);
    if (!mediaList?.length) {
      return [];
    }

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
    if (!bestMedia || bestScore < 60) {
      return [];
    }

    const anilistId = bestMedia.id;

    // Step 2: Check episodes and dub availability
    const epData = await apiGet(`/api/watch/episodes?anilistId=${anilistId}`);
    if (!epData) {
      return [];
    }

    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const dubAvailable = epData.dubAvailable === true;

    // Step 3: Fetch streams for sub and dub
    const results = [];
    const seenUrls = new Set();
    const types = dubAvailable ? ['sub', 'dub'] : ['sub'];

    for (const type of types) {
      try {
        const data = await apiGet(`/api/watch/servers?anilistId=${anilistId}&episode=${epNum}&type=${type}`);
        if (!data?.servers?.length) continue;

        for (const server of data.servers) {
          if (!server.stream) continue;

          // Build absolute stream URL
          const streamUrl = server.stream.startsWith('http')
            ? server.stream
            : `${BASE}${server.stream}`;
          if (seenUrls.has(streamUrl)) continue;
          seenUrls.add(streamUrl);

          let parsed;
          try { parsed = new URL(streamUrl); } catch { continue; }

          // Determine audio label and country codes
          const audioLabel = type === 'dub' ? 'DUB' : 'SUB';
          const countryCodes = type === 'dub'
            ? [CountryCode.multi, CountryCode.en]
            : [CountryCode.multi, CountryCode.ja];

          // The NuvioExtractor routes this URL through /proxy with forceHls=1.
          // The m3u8 at /api/watch/m3u8 has RELATIVE variant URLs that must
          // be rewritten — the proxy buffers, detects #EXTM3U, rewrites URLs.
          results.push({
            url: parsed,  // ORIGINAL URL — NuvioExtractor routes through /proxy
            format: Format.hls,
            meta: {
              countryCodes,
              title: `${title} (AniChan ${audioLabel})`,
              sourceId: this.id,
              sourceLabel: this.label,
              height: 1080,
              // NuvioExtractor flags — route through /proxy with forceHls
              nuvioProvider: true,
              nuvioForceHls: true,
            },
          });
        }
      } catch (e) {
      }
    }

    return results;
  }
}
