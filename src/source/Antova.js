// src/source/Antova.js
// anilibria.top (rebranded "AniLiberty" / "Antova") — Russian-dubbed anime
//
// Public REST API at https://anilibria.top/api/v1 — NO AUTH REQUIRED.
// All endpoints return 200. Tested live 2026-08-10.
//
// API flow (verified live, server-side playable):
//   1. GET /app/search/releases?query={title}&limit=20
//        → array of { alias, year, name: { main, english, alternative } }
//   2. GET /anime/releases/{alias}
//        → { name, episodes: [{ ordinal, duration, hls_480, hls_720, hls_1080 }] }
//
// Stream URL pattern:
//   https://cache.libria.fun/videos/media/ts/{releaseId}/{episode}/{quality}/{hash}.m3u8
//     ?countryIso=HK&isAuthorized=0&isWithVideoAds=1&isWithVideoAdsAlways=1
//
// The m3u8 playlist has absolute TS segment URLs (no relative path rewriting
// needed). Stremio plays these directly — no proxy or Referer required.
//
// Audio: All streams are Russian-dubbed (AniLibria is a Russian fan-dub group).
// Original Japanese audio is not available separately — the dub is baked in.
// Subtitles: None (the dub replaces the original audio).
//
// NOTE: AniLibria doesn't have myanimelist_id/anilist_id fields — we match by
// fuzzy title (Levenshtein-style ratio). Year is used as a disambiguator.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const API_BASE = 'https://anilibria.top/api/v1';
const ORIGIN = 'https://anilibria.top';

const hg = new HeaderGenerator({
  browsers: ['chrome'],
  devices: ['desktop'],
  operatingSystems: ['windows'],
  locales: ['en-US', 'en'],
});

function apiHeaders() {
  return {
    ...hg.getHeaders({ httpVersion: '2' }),
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

async function fetchJson(url) {
  const res = await gotScraping.get(url, {
    headers: apiHeaders(),
    timeout: { request: 15000 },
    throwHttpErrors: false,
    http2: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// Levenshtein distance for fuzzy title matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function fuzzRatio(a, b) {
  if (a === b) return 100;
  if (!a.length || !b.length) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Math.round((1 - dist / maxLen) * 100);
}

// Normalize for fuzzy matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// Strip year suffix like "Berserk (2016)" → "Berserk"
const stripYear = (s) => (s || '').replace(/\s*[\(\[]\d{4}[\)\]]\s*$/, '').trim();

export class Antova extends Source {
  constructor(fetcher) {
    super();
    this.id = 'antova';
    this.label = 'Antova';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.ru];
    this.baseUrl = ORIGIN;
    this.fetcher = fetcher;
    // Stream URLs are signed but stable — 30min cache
    this.ttl = 30 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search by title
    const searchUrl = `${API_BASE}/app/search/releases?query=${encodeURIComponent(name)}&limit=20`;
    const searchData = await fetchJson(searchUrl);
    if (!searchData) return [];

    const results = Array.isArray(searchData) ? searchData : (searchData.data || []);
    if (results.length === 0) return [];

    // Step 2: Fuzzy-match the title
    const cleanTitle = normalize(stripYear(name));
    // Also strip "Season N" / "Part N" / "TV" etc. for matching
    const cleanTitleBase = cleanTitle.replace(/\s*:\s*.*$/, '').trim();

    let bestMatch = null;
    let bestScore = 0;
    for (const r of results) {
      const names = r.name || {};
      const candidates = [
        names.main, names.english,
        (names.alternative || '').split('/')[0],
      ].filter(Boolean).map(stripYear).map(normalize);
      if (!candidates.length) continue;

      let score = Math.max(...candidates.map(c => fuzzRatio(cleanTitleBase, c)));
      // Year bonus
      if (year && r.year === year) score += 15;
      else if (year && r.year && r.year !== year) score -= 10;

      if (score > bestScore) { bestScore = score; bestMatch = r; }
    }

    // Require score >= 60 to avoid mismatches
    if (!bestMatch || bestScore < 60) return [];

    // Step 3: Get the full release detail (includes episodes with HLS URLs)
    const release = await fetchJson(`${API_BASE}/anime/releases/${bestMatch.alias}`);
    if (!release?.episodes) return [];

    // Step 4: For movies (no season), use episode 1
    // For series, find the matching episode by ordinal
    const targetEpisode = tmdbId.season ? tmdbId.episode : 1;
    // AniLibria uses absolute episode numbering (no season concept)
    // For Stremio season 1, episode N → AniLibria episode N
    // For Stremio season 2+, we need to skip ahead — but AniLibria often has
    // separate releases for each season (e.g., "jujutsu-kaisen-season-2")
    // so the season is already encoded in the release choice.
    const episode = release.episodes.find(e => Number(e.ordinal) === targetEpisode)
                 || release.episodes[0];
    if (!episode) return [];

    // Step 5: Build stream results for each quality
    const streams = [];
    const seenUrls = new Set();
    const qualityLabels = [
      { key: 'hls_1080', label: '1080p', height: 1080 },
      { key: 'hls_720',  label: '720p',  height: 720  },
      { key: 'hls_480',  label: '480p',  height: 480  },
    ];

    for (const q of qualityLabels) {
      const url = episode[q.key];
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      let parsed;
      try { parsed = new URL(url); } catch { continue; }

      streams.push({
        url: parsed,
        format: Format.hls,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.ja, CountryCode.ru],
          title: `${titleBase} (Antova ${q.label} RU)`,
          sourceId: this.id,
          sourceLabel: this.label,
          height: q.height,
        },
      });
    }

    return streams;
  }
}
