// src/source/AnimeZeY.js
// animezey — anime-only with sub+dub HLS streams
//
// Uses the Nuvio provider (src/nuvio/animezey.cjs) which returns direct URLs
// from animezey workers.dev. No Referer required.
//
// Anime-only provider — does not work for movies or TV series.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'animezey.cjs');

export class AnimeZeY extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animezey';
    this.label = 'AnimeZeY';
    this.contentTypes = ['series']; // anime-only
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = 'https://animezey.com';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // animezey is anime-only — requires season/episode
    if (!tmdbId.season) return [];

    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType: 'tv',
      season: tmdbId.season,
      episode: tmdbId.episode || 1,
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
