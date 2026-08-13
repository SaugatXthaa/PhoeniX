// src/source/AniVault.js
// AniVault API (anivault-api.up.railway.app) — anime with sub/dub
//
// Uses the AniVault Scraper API which provides direct MP4 (AnimeHeaven)
// and HLS (Anikoto) streams. The API uses AniList IDs and supports both
// sub and dub.
//
// Flow:
//   1. Resolve AniList ID via AniList GraphQL search by name
//   2. GET /api/watch/{source}/{anilistId}/{episode}/{type}
//      source: animeheaven (MP4) or anikoto (HLS)
//      type: sub or dub
//   3. Response includes:
//      - mp4: direct MP4 URL (animeheaven)
//      - m3u8: direct HLS URL (anikoto)
//      - hlsProxyUrl: CORS-safe proxied HLS URL
//      - subtitles: VTT subtitle tracks
//      - playbackMode: "mp4" | "hls"
//
// Both sub and dub streams are returned from both sources.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const API_BASE = 'https://anivault-api.up.railway.app/api';
const ANILIST_GQL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function apiGet(path) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(`${API_BASE}${path}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: { request: 25000 },
    throwHttpErrors: false,
    followRedirect: true,
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
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    return data?.data?.Page?.media || [];
  } catch { return null; }
}

export class AniVault extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anivault';
    this.label = 'AniVault';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = 'https://www.anivault.co';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream URLs may expire
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

    // Step 2: Fetch streams from both sources, both sub and dub
    const results = [];
    const seenUrls = new Set();
    const sources = [
      { source: 'animeheaven', label: 'AnimeHeaven' },
      { source: 'anikoto', label: 'Anikoto' },
    ];
    const types = ['sub', 'dub'];

    for (const { source, label } of sources) {
      for (const type of types) {
        try {
          const data = await apiGet(`/watch/${source}/${anilistId}/${epNum}/${type}`);
          if (!data) continue;

          // Verify the stream title from the API matches the requested anime
          // to prevent "playing random anime but showing requested title" bug.
          // The AniVault API sometimes returns wrong content for a given
          // AniList ID — skip if the title doesn't match.
          const apiTitle = data.title || data.animeTitle || '';
          if (apiTitle) {
            const apiNorm = normalize(apiTitle);
            if (apiNorm && !apiNorm.includes(nameNorm) && !nameNorm.includes(apiNorm) &&
                apiNorm.split(' ')[0] !== nameNorm.split(' ')[0]) {
              // Title doesn't match — skip this stream to avoid wrong content
              continue;
            }
          }

          const streamUrl = data.m3u8 || data.mp4 || data.rawStreamUrl;
          if (!streamUrl) continue;
          if (seenUrls.has(streamUrl)) continue;
          seenUrls.add(streamUrl);

          let parsed;
          try { parsed = new URL(streamUrl); } catch { continue; }

          const format = data.playbackMode === 'mp4' ? Format.mp4 : Format.hls;
          const audioLabel = type === 'dub' ? 'Dub' : 'Sub';
          const countryCodes = type === 'dub'
            ? [CountryCode.multi, CountryCode.en]
            : [CountryCode.multi, CountryCode.ja];

          // Return the DIRECT stream URL with requestHeaders.
          // For anikoto HLS: the Megaplay extractor claims megaplay.buzz URLs,
          // but these are megap.* URLs — the AnimeDirect extractor handles them
          // via /proxy with the correct Referer.
          // For animeheaven MP4: the DirectStream extractor handles rt.animeheaven.me
          const requestHeaders = source === 'anikoto'
            ? { Referer: 'https://megaplay.buzz/' }
            : undefined;

          results.push({
            url: parsed,
            format,
            ...(requestHeaders && { requestHeaders }),
            meta: {
              countryCodes,
              title: `${title} (${audioLabel} · ${label})`,
              sourceId: this.id,
              sourceLabel: this.label,
            },
          });
        } catch { /* skip failed source */ }
      }
    }

    return results;
  }
}
