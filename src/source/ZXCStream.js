// src/source/ZXCStream.js
// zxcstream — movies/series/anime via player.zxcstream.xyz embed URLs
//
// Uses the Nuvio provider (src/nuvio/zxcstream.cjs) which generates an auth
// token (sha512) and calls the /backend_/embed/sentinel endpoint to get an
// iframe embed URL for the content.
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'movie'|'tv', season, episode)
//   3. Convert streams to Source result format via buildStreamResults()
//
// The provider returns embed URLs (iframe pages) — NuvioExtractor routes
// them through /proxy with forceHls=1 to detect if the response is HLS.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'zxcstream.cjs');

export class ZXCStream extends Source {
  constructor(fetcher) {
    super();
    this.id = 'zxcstream';
    this.label = 'ZXCStream';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://player.zxcstream.xyz';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — tokens are time-limited
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
      timeoutMs: 25000,
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
