// src/source/NowHDTime.js
// nowhdtime.to / nowhdtime.com.bd — movies, series, anime, kdrama
//
// Uses the nhdapi.com JSON API (TMDB-ID-keyed) which returns a direct HLS
// proxy URL (playUrl) that Stremio can play directly — no extraction needed.
//
// Flow (clean JSON API, no scraping):
//   1. GET https://nhdapi.com/api/movie/{tmdbId}
//      or GET https://nhdapi.com/api/tv/{tmdbId}/{season}/{episode}
//      Header: X-API-Key: 7d5239afc1d0a4fa374587d1d3feb1b0
//   2. Response: { success: true, playUrl: "https://nhdapi.com/api/hls?t=...", kind: "hls" }
//   3. The playUrl is a CORS-open HLS proxy that handles all CDN/referer complexity
//      — Stremio can play it directly without any proxy or headers
//
// The API is fast (~0-9s, cached server-side). Stream tokens are time-limited.
// All content types (movies, series, anime, kdrama) are supported via TMDB IDs.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const API_BASE = 'https://nhdapi.com/api';
const API_KEY = '7d5239afc1d0a4fa374587d1d3feb1b0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function apiGet(path) {
  const { gotScraping } = await import('got-scraping');
  const r = await gotScraping.get(`${API_BASE}${path}`, {
    headers: { 'User-Agent': UA, 'X-API-Key': API_KEY, 'Accept': 'application/json' },
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  if (r.statusCode !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

export class NowHDTime extends Source {
  constructor(fetcher) {
    super();
    this.id = 'nowhdtime';
    this.label = 'NowHDTime';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://www.nowhdtime.to';
    this.fetcher = fetcher;
    // Stream tokens are time-limited — use short cache TTL
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Build API path — movies use /movie/{id}, TV/anime use /tv/{id}/{s}/{e}
    const apiPath = tmdbId.season
      ? `/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`
      : `/movie/${tmdbId.id}`;

    const data = await apiGet(apiPath);
    if (!data?.success || !data.playUrl) return [];

    // The playUrl is a CORS-open HLS proxy URL — Stremio can play it directly
    let parsed;
    try { parsed = new URL(data.playUrl); } catch { return []; }

    // Try to extract resolution from the m3u8 playlist
    let height;
    try {
      const { gotScraping } = await import('got-scraping');
      const r = await gotScraping.get(data.playUrl, {
        headers: { 'User-Agent': UA },
        timeout: { request: 10000 }, throwHttpErrors: false,
      });
      if (r.statusCode === 200) {
        const resMatch = r.body.match(/RESOLUTION=\d+x(\d+)/i);
        if (resMatch) height = parseInt(resMatch[1]);
      }
    } catch { /* resolution detection failed — not critical */ }

    const results = [{
      url: parsed,
      format: Format.hls,
      meta: {
        countryCodes: [CountryCode.multi],
        title: `${title} (HLS)`,
        sourceId: this.id,
        sourceLabel: this.label,
        ...(height && { height }),
      },
    }];

    return results;
  }
}
