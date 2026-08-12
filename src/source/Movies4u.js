// src/source/Movies4u.js
// movies4u — movies (Hindi/English) with 4K and 1080p direct MP4/MKV streams
//
// Uses the Nuvio provider (src/nuvio/movies4u.cjs) which returns direct URLs
// from *.r2.dev (Cloudflare R2) and video-downloads.googleusercontent.com.
// No Referer required — all URLs are direct-playable.
//
// Movies-only provider — does not support TV series.
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'movie', null, null)
//   3. Convert streams to Source result format via buildStreamResults()
//
// Note: movies4u is slower (20-30s) due to multiple API calls.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'movies4u.cjs');

export class Movies4u extends Source {
  constructor(fetcher) {
    super();
    this.id = 'movies4u';
    this.label = 'Movies4u';
    this.contentTypes = ['movie']; // movies-only
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://movies4u.co';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // movies4u is movies-only — skip if this is a TV series request
    if (tmdbId.season) return [];

    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType: 'movie',
      season: null,
      episode: null,
      timeoutMs: 18000, // movies4u is slow, cap at 18s to avoid blocking response
    });

    return buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
