// src/source/DahmerMovies4k.js
// dahmermovies-4k — movies and TV series with 4K-focused streams
//
// Uses the Nuvio provider (src/nuvio/dahmermovies-4k.cjs) which returns 4K
// URLs from p.111477.xyz (bulk proxy) that proxy to a.111477.xyz movies/tvs.
// Requires Referer: https://a.111477.xyz/
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'movie'|'tv', season, episode)
//   3. Convert streams to Source result format via buildStreamResults()
//
// Note: dahmermovies-4k is slower for TV series (30-40s) due to multiple
// season/episode lookups. The provider timeout is set to 40s.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'dahmermovies-4k.cjs');

export class DahmerMovies4k extends Source {
  constructor(fetcher) {
    super();
    this.id = 'dahmermovies4k';
    this.label = 'DahmerMovies 4K';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://a.111477.xyz';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      timeoutMs: 28000, // dahmermovies-4k is slower for TV, stay under 30s source timeout
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
