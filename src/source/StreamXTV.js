// src/source/StreamXTV.js
// streamxtv.tech — TMDB (movies/TV) + AniList (anime) aggregator
//
// StreamXTV is a React SPA backed by a clean JSON API at
//   https://streamx-backend-myr0.onrender.com/api
// It bundles ~22 third-party embed providers. The site's own embed player
// (embed.streamxtv.tech) is currently dead (HTTP 402), so we route to
// third-party providers that have working extractors in this addon:
//
//   - vidsrc-embed.ru/embed/movie/{id}        → VidSrc extractor
//   - www.vidking.net/embed/movie/{id}        → VidKing extractor
//   - player.vidzee.wtf/embed/movie/{id}      → Vidzee extractor
//   - player.videasy.net/movie/{id}           → (via meta.vidking fallback)
//
// For movies, we pass meta.vidking for the VidKing extractor's speedracelight
// fallback. Series rely on the VidSrc extractor's embed-page parsing.
//
// For anime, Stremio passes kitsu:/mal: IDs which we resolve to TMDB, then
// to a name, then search streamxtv's AniList-backed /anime/search endpoint
// to get the AniList ID. We then build megaplay.buzz URLs with sub/dub:
//   https://megaplay.buzz/stream/ani/{anilistId}/{ep}/{sub|dub}
//
// The Megaplay extractor routes these through /proxy with the appropriate
// Referer so Stremio can attempt playback.
//
// NOTE: The Render free-tier backend sleeps when idle. First request after
// inactivity can take 15-30s. We use a 30s timeout to handle cold starts.

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const API_BASE = 'https://streamx-backend-myr0.onrender.com/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Providers with working extractors in this addon
const MOVIE_TV_PROVIDERS = [
  { label: 'VidSrc',   movie: 'https://vidsrc-embed.ru/embed/movie/{id}?autoplay=0',  tv: 'https://vidsrc-embed.ru/embed/tv/{id}-{s}-{e}?autoplay=0&autonext=0' },
  { label: 'VidKing',  movie: 'https://www.vidking.net/embed/movie/{id}?autoPlay=false', tv: 'https://www.vidking.net/embed/tv/{id}/{s}/{e}?autoPlay=false&nextEpisode=false' },
  { label: 'Vidzee',   movie: 'https://player.vidzee.wtf/embed/movie/{id}',           tv: 'https://player.vidzee.wtf/embed/tv/{id}?season={s}&episode={e}' },
  { label: 'Videasy',  movie: 'https://player.videasy.net/movie/{id}',                tv: 'https://player.videasy.net/tv/{id}/{s}/{e}' },
];

// Anime providers — Megaplay is the most reliable, with sub/dub support
const ANIME_PROVIDERS = [
  { label: 'Megaplay', url: 'https://megaplay.buzz/stream/ani/{anilistId}/{ep}/{subDub}' },
  { label: 'VidNest',  url: 'https://vidnest.fun/anime/{anilistId}/{ep}/{subDub}' },
];

// Normalize for fuzzy matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function fetchJson(url, referer) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*', ...(referer && { Referer: referer }) },
    timeout: { request: 30000 },
    throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

export class StreamXTV extends Source {
  constructor(fetcher) {
    super();
    this.id = 'streamxtv';
    this.label = 'StreamXTV';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = 'https://streamxtv.tech';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Detect anime via TMDB genres: genre 16 (Animation) + keyword 210024 (anime)
    // OR by checking if streamxtv's anime search returns a strong match
    const animeMatch = await this.findAniListId(name);

    const results = [];

    if (animeMatch) {
      // ANIME path — build Megaplay URLs with sub + dub
      const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;
      for (const subDub of ['sub', 'dub']) {
        for (const provider of ANIME_PROVIDERS) {
          const url = provider.url
            .replace('{anilistId}', animeMatch.id)
            .replace('{ep}', epNum)
            .replace('{subDub}', subDub);
          results.push({
            url: new URL(url),
            meta: {
              countryCodes: [CountryCode.multi, CountryCode.ja, ...(subDub === 'dub' ? [CountryCode.en] : [])],
              title: `${title} (${provider.label} ${subDub.toUpperCase()})`,
              sourceId: this.id,
              sourceLabel: this.label,
            },
          });
        }
      }
    }

    // MOVIES / TV path — always include (anime can also appear in TMDB TV)
    // Pass meta.vidking for movies only — speedracelight returns wrong content
    // for series/anime (see VidSrc.js / Movie4kTo.js comments).
    const vidkingMeta = tmdbId.season ? null : {
      name, year, tmdbId: tmdbId.id,
    };

    for (const source of MOVIE_TV_PROVIDERS) {
      const url = tmdbId.season
        ? source.tv.replace('{id}', tmdbId.id).replace('{s}', tmdbId.season).replace('{e}', tmdbId.episode)
        : source.movie.replace('{id}', tmdbId.id);

      results.push({
        url: new URL(url),
        meta: {
          countryCodes: [CountryCode.multi],
          title: `${title} (${source.label})`,
          ...(vidkingMeta && { vidking: vidkingMeta }),
        },
      });
    }

    return results;
  }

  // Search streamxtv's anime backend to find AniList ID for this title.
  // Returns { id, title } or null if no match.
  async findAniListId(name) {
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const nameNorm = normalize(name);

    for (const query of queries) {
      const url = `${API_BASE}/anime/search?q=${encodeURIComponent(query)}`;
      const data = await fetchJson(url, 'https://streamxtv.tech/');
      if (!data?.results?.length) continue;

      // Find best match by normalized title comparison
      let best = null;
      let bestScore = 0;
      for (const r of data.results) {
        const rNorm = normalize(r.title);
        if (!rNorm) continue;
        // Exact match
        if (rNorm === nameNorm) { best = r; bestScore = 100; break; }
        // One contains the other
        if (rNorm.includes(nameNorm) || nameNorm.includes(rNorm)) {
          const score = Math.min(rNorm.length, nameNorm.length) / Math.max(rNorm.length, nameNorm.length);
          if (score > bestScore) { best = r; bestScore = score; }
        }
        // First-word match (good for "Naruto Shippuden" → "Naruto")
        const firstName = nameNorm.split(' ')[0];
        if (firstName.length > 3 && rNorm.startsWith(firstName)) {
          const score = firstName.length / rNorm.length * 0.7;
          if (score > bestScore) { best = r; bestScore = score; }
        }
      }

      // Only accept matches with a reasonable score
      if (best && bestScore >= 50) {
        return { id: best.id, title: best.title };
      }
    }

    return null;
  }
}
