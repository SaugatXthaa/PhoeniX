// src/source/HDGharTV.js
// hdghartv.cc — movies, series, anime, kdrama with multi-audio HLS streams
//
// Public REST API at https://hdghartv.cc/api/ — NO AUTH REQUIRED.
//
// API flow (verified live, server-side playable):
//   1. GET /api/search?q={title}
//        → { movies[], series[], actors[], total }
//        Each item has { _id, title, tmdbId, releaseDate }
//   2. GET /api/movies/public/{_id}
//        → { title, tmdbId, streamingLinks: [{ quality, url, type, isActive }] }
//   3. GET /api/series/public/{_id}
//        → { title, tmdbId, seasons: [{ seasonNumber, episodes: [{
//              episodeNumber, streamingLinks: [...] }] }] }
//
// Stream URL pattern:
//   https://cdn{N}.streamraiwind.stream/img/{hash}/nasty.m3u8?token=...&expires=...
//
// The m3u8 master playlist contains multiple audio tracks (Hindi, English, etc.)
// as #EXT-X-MEDIA entries. URLs have signed `token` + `expires` query params —
// typically valid for ~1 hour.
//
// No special Referer/Origin needed — Stremio plays these directly.
// We route through the addon's /proxy endpoint only if needed for HLS rewriting
// (handled by the index.js proxy logic automatically).

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const API_BASE = 'https://hdghartv.cc/api';
const ORIGIN = 'https://hdghartv.cc';

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
    'Referer': `${ORIGIN}/`,
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

// Parse resolution string ("480p", "720p", "1080p") to height
function parseHeight(quality) {
  if (!quality) return undefined;
  const m = String(quality).match(/(\d{3,4})p?/i);
  return m ? parseInt(m[1], 10) : undefined;
}

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

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

export class HDGharTV extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hdghartv';
    this.label = 'HDGharTV';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = ORIGIN;
    this.fetcher = fetcher;
    // Stream tokens are time-limited (~1h) — short cache
    this.ttl = 30 * 60 * 1000; // 30min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search by title — the API does substring matching on title
    const searchData = await fetchJson(`${API_BASE}/search?q=${encodeURIComponent(name)}`);
    if (!searchData) return [];

    const items = tmdbId.season
      ? (searchData.series || [])
      : (searchData.movies || []);

    if (items.length === 0) return [];

    // Step 2: Find best match — prefer exact TMDB ID match, else fuzzy title match
    let bestMatch = null;
    const nameNorm = normalize(name);

    // First pass: exact TMDB ID match
    for (const item of items) {
      if (item.tmdbId === Number(tmdbId.id)) {
        bestMatch = item;
        break;
      }
    }

    // Fallback: fuzzy title match (with year bonus)
    if (!bestMatch) {
      let bestScore = 0;
      for (const item of items) {
        const tNorm = normalize(item.title);
        if (!tNorm) continue;
        let score = 0;
        if (tNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        }
        if (year && item.releaseDate?.startsWith(String(year))) score += 15;
        if (score > bestScore) { bestScore = score; bestMatch = item; }
      }
      // Require score >= 60 to avoid mismatches
      if (bestScore < 60) bestMatch = null;
    }

    if (!bestMatch) return [];

    // Step 3: Fetch detail to get streaming links
    const detailPath = tmdbId.season
      ? `/series/public/${bestMatch._id}`
      : `/movies/public/${bestMatch._id}`;
    const detail = await fetchJson(`${API_BASE}${detailPath}`);
    if (!detail) return [];

    // Step 4: Extract streaming links
    let linkGroups = [];
    if (tmdbId.season) {
      // Series: find the right season + episode
      for (const s of (detail.seasons || [])) {
        if (s.seasonNumber !== tmdbId.season) continue;
        for (const ep of (s.episodes || [])) {
          if (ep.episodeNumber !== tmdbId.episode) continue;
          for (const l of (ep.streamingLinks || [])) {
            if (l.isActive !== false && l.url) {
              linkGroups.push({ link: l, episodeLabel: `S${tmdbId.season}E${tmdbId.episode}` });
            }
          }
        }
      }
    } else {
      // Movie: all streaming links
      for (const l of (detail.streamingLinks || [])) {
        if (l.isActive !== false && l.url) {
          linkGroups.push({ link: l, episodeLabel: null });
        }
      }
    }

    if (linkGroups.length === 0) return [];

    // Step 5: Build stream results
    const results = [];
    const seenUrls = new Set();

    for (const { link, episodeLabel } of linkGroups) {
      if (seenUrls.has(link.url)) continue;
      seenUrls.add(link.url);

      let parsed;
      try { parsed = new URL(link.url); } catch { continue; }

      const height = parseHeight(link.quality);
      const format = link.type === 'hls' ? Format.hls : Format.mp4;

      // Detect available audio tracks by fetching the master playlist
      // (cheap — only fetches the small m3u8 file, not the segments)
      let countryCodes = [CountryCode.multi];
      try {
        const m3u8Res = await gotScraping.get(link.url, {
          headers: { ...hg.getHeaders({ httpVersion: '2' }) },
          timeout: { request: 5000 }, throwHttpErrors: false, http2: true,
        });
        if (m3u8Res.statusCode === 200) {
          const text = m3u8Res.body;
          const codes = new Set([CountryCode.multi]);
          if (/LANGUAGE="Hindi"/i.test(text)) codes.add(CountryCode.hi);
          if (/LANGUAGE="English"/i.test(text)) codes.add(CountryCode.en);
          if (/LANGUAGE="Tamil"/i.test(text)) codes.add(CountryCode.ta);
          if (/LANGUAGE="Telugu"/i.test(text)) codes.add(CountryCode.te);
          if (/LANGUAGE="Korean"/i.test(text)) codes.add(CountryCode.ko);
          if (/LANGUAGE="Japanese"/i.test(text)) codes.add(CountryCode.ja);
          countryCodes = [...codes];
        }
      } catch { /* not critical — keep default */ }

      const titleSuffix = episodeLabel
        ? `${episodeLabel} (${link.quality || 'HD'})`
        : `(${link.quality || 'HD'})`;

      results.push({
        url: parsed,
        format,
        meta: {
          countryCodes,
          title: `${titleBase} ${titleSuffix}`,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
        },
      });
    }

    return results;
  }
}
