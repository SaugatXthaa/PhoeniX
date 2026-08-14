// src/source/AnimeWorldIN.js
// animeworld (India) — anime with HLS streams (1080p)
//
// Uses the Nuvio provider (src/nuvio/animeworld.cjs) which scrapes
// watchanimeworld.top and returns HLS URLs from play.zephyrix.top.
// Requires Referer: https://play.zephyrix.top/
//
// Anime-only provider — does not work for movies or TV series.
// ID is 'animeworldindia' to avoid conflict with existing 'animeworld' source
// (which is the German anime-world.scfe-clan.net site).
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'tv', season, episode)
//   3. Convert streams to Source result format via buildStreamResults()

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'animeworld.cjs');

export class AnimeWorldIN extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animeworldindia';
    this.label = 'AnimeWorld IN';
    this.contentTypes = ['series']; // anime-only
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = 'https://watchanimeworld.top';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // AnimeWorld IN is anime-only — requires season/episode
    if (!tmdbId.season) return [];

    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType: 'tv',
      season: tmdbId.season,
      episode: tmdbId.episode || 1,
      timeoutMs: 13000, // stay under 30s source timeout
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
