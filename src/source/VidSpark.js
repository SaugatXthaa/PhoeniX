// src/source/VidSpark.js
// vidspark.to — movies and TV series with direct HLS streams
//
// Flow:
//   1. VidSpark uses TMDB IDs directly — no search needed
//   2. Call /api/vidora/v1/movie/{tmdbId} or /api/vidora/v1/tv/{tmdbId}/{s}/{e}
//      with x-player-key header
//   3. API returns { result: true, sources: [{ url, tracks }], title, year }
//   4. The HLS URL requires Referer: https://vidspark.to/ to play
//
// The HLS streams are on bx.netrocdn.site and support multiple quality variants.
// Subtitles are included in the API response as tracks.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://vidspark.to';
const PLAYER_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';
const REFERER = 'https://vidspark.to/';

export class VidSpark extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vidspark';
    this.label = 'VidSpark';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Build API URL
    const apiPath = tmdbId.season
      ? `/api/vidora/v1/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`
      : `/api/vidora/v1/movie/${tmdbId.id}`;

    const apiUrl = new URL(apiPath, BASE_URL);

    // Fetch stream data from VidSpark API
    let data;
    try {
      const { gotScraping } = await import('got-scraping');
      const res = await gotScraping.get(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'x-player-key': PLAYER_KEY,
          'Referer': `${BASE_URL}/`,
          'Accept': 'application/json',
        },
        timeout: { request: 10000 },
        throwHttpErrors: false,
      });

      if (res.statusCode !== 200) return [];
      data = JSON.parse(res.body);
    } catch { return []; }

    if (!data?.result || !data?.sources?.[0]?.url) return [];

    const streamUrl = data.sources[0].url;
    let parsed;
    try { parsed = new URL(streamUrl); } catch { return []; }
    if (!parsed) return [];

    // Return the HLS URL directly — the AnimeDirect extractor handles
    // routing through /proxy with the correct Referer for CDN hosts.
    const results = [{
      url: parsed,
      format: Format.hls,
      meta: {
        countryCodes: [CountryCode.multi],
        title: `${title} (HLS)`,
        sourceId: this.id,
        sourceLabel: this.label,
      },
      requestHeaders: { Referer: REFERER },
    }];

    return results;
  }
}
