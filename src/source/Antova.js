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
//        → { name, episodes: [{ ordinal, sort_order, hls_480, hls_720, hls_1080 }],
//            members: [{ role: { value: "voicing" }, nickname }] }
//
// Stream URL pattern:
//   https://cache.libria.fun/videos/media/ts/{releaseId}/{episode}/{quality}/{hash}.m3u8
//     ?countryIso=HK&isAuthorized=0&isWithVideoAds=1&isWithVideoAdsAlways=1
//
// The m3u8 playlist has absolute TS segment URLs (no relative path rewriting
// needed). Stremio plays these directly — no proxy or Referer required.
//
// Audio: All streams are Russian-dubbed (AniLibria is a Russian fan-dub group).
// Each release has one voice team (listed in members[] with role "voicing").
// The voice team name is included in the stream title so users can distinguish
// different dub teams.
//
// Episode matching:
//   AniLibria uses absolute episode numbering (ordinal field). For most releases
//   ordinal starts at 1, but some start at a higher number (e.g., Naruto
//   Shippuuden starts at ordinal 370). We match by ordinal, and if the exact
//   episode isn't found, we return [] (no streams) instead of falling back to
//   episodes[0] which would return wrong content.
//
// Multi-season handling:
//   AniLibria often has separate releases for each season (e.g.,
//   "jujutsu-kaisen" for S1, "jujutsu-kaisen-season-2" for S2). We match the
//   best release by title + year, and for multi-season anime, the search results
//   usually contain all seasons as separate releases.
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

// Extract voice team name from release members
function getVoiceTeam(release) {
  const voices = (release.members || []).filter(m => m.role?.value === 'voicing').map(m => m.nickname);
  return voices.length > 0 ? voices.slice(0, 3).join(', ') : null;
}

// Run async tasks with bounded concurrency
async function mapBounded(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (idx < items.length) {
      const cur = idx++;
      try { results[cur] = await fn(items[cur], cur); }
      catch { results[cur] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

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

    // Step 1: Search by title with multiple queries to maximize match chances
    // Try the full name first, then a shortened version (strip subtitle after colon)
    const cleanName = stripYear(name);
    const shortName = cleanName.replace(/\s*:\s*.*$/, '').trim();
    const queries = [name, cleanName, shortName]
      .filter((q, i, arr) => q && arr.indexOf(q) === i && q.length > 2);

    let results = [];
    for (const query of queries) {
      const searchUrl = `${API_BASE}/app/search/releases?query=${encodeURIComponent(query)}&limit=20`;
      const searchData = await fetchJson(searchUrl);
      const searchResults = Array.isArray(searchData) ? searchData : (searchData?.data || []);
      // Merge results, dedup by alias
      for (const r of searchResults) {
        if (!results.find(x => x.alias === r.alias)) results.push(r);
      }
      if (results.length >= 10) break; // enough results
    }

    if (results.length === 0) return [];

    // Step 2: Fuzzy-match the title — collect ALL matching releases (score >= 60)
    // Multiple releases may match (e.g., "jujutsu-kaisen" and "jujutsu-kaisen-season-2")
    // We want to find the one that matches the requested season.
    const cleanTitle = normalize(cleanName);
    const cleanTitleBase = normalize(shortName);

    const matches = [];
    for (const r of results) {
      const names = r.name || {};
      const candidates = [
        names.main, names.english,
        (names.alternative || '').split('/')[0],
      ].filter(Boolean).map(stripYear).map(normalize);
      if (!candidates.length) continue;

      // Score against both full title and shortened title
      let score = Math.max(...candidates.map(c => Math.max(
        fuzzRatio(cleanTitle, c),
        fuzzRatio(cleanTitleBase, c),
      )));

      // Year bonus — strong signal for season matching
      if (year && r.year === year) score += 20;
      else if (year && r.year && Math.abs(r.year - year) <= 1) score += 5;
      else if (year && r.year && r.year !== year) score -= 10;

      if (score >= 60) {
        matches.push({ release: r, score });
      }
    }

    if (matches.length === 0) return [];

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    // For series with seasons: if Stremio requests S2+, try to find a season-specific release
    // (e.g., "jujutsu-kaisen-season-2"). Otherwise use the best match.
    // For movies (no season), use the best match.
    let bestMatch = matches[0].release;

    // If it's a series with season > 1, look for a season-specific release
    if (tmdbId.season && tmdbId.season > 1) {
      const seasonStr = String(tmdbId.season);
      const seasonMatch = matches.find(m => {
        const alias = m.release.alias.toLowerCase();
        return alias.includes(`season-${seasonStr}`) ||
               alias.includes(`${seasonStr}-season`) ||
               alias.includes(`s${seasonStr}`);
      });
      if (seasonMatch) bestMatch = seasonMatch.release;
    }

    // Step 3: Get the full release detail (includes episodes with HLS URLs)
    const release = await fetchJson(`${API_BASE}/anime/releases/${bestMatch.alias}`);
    if (!release?.episodes || release.episodes.length === 0) return [];

    // Step 4: Find the matching episode
    // For movies (no season), use episode 1 (ordinal 1)
    // For series, match by ordinal
    const targetEpisode = tmdbId.season ? tmdbId.episode : 1;
    let episode = release.episodes.find(e => Number(e.ordinal) === targetEpisode);

    // If exact ordinal not found, try sort_order (some releases use sort_order starting at 1)
    if (!episode) {
      episode = release.episodes.find(e => Number(e.sort_order) === targetEpisode);
    }

    // If still not found and this is episode 1, check if ordinals start at 1
    if (!episode && targetEpisode === 1 && release.episodes[0]) {
      const firstOrd = Number(release.episodes[0].ordinal);
      const firstSort = Number(release.episodes[0].sort_order);
      if (firstOrd === 1 || firstSort === 1) {
        episode = release.episodes[0];
      }
    }

    // If no matching episode found, return empty — don't fall back to episodes[0]
    // (would return wrong content, e.g., Naruto Shippuuden episode 370 for S01E01)
    if (!episode) return [];

    // Step 5: Get voice team for labeling
    const voiceTeam = getVoiceTeam(release);
    const teamLabel = voiceTeam ? ` · ${voiceTeam}` : '';

    // Step 6: Build stream results for each quality
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
          title: `${titleBase} (Antova ${q.label} RU Dub${teamLabel})`,
          sourceId: this.id,
          sourceLabel: this.label,
          height: q.height,
        },
      });
    }

    return streams;
  }
}
