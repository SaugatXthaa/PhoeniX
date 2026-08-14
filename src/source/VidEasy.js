// src/source/VidEasy.js
// videasy — movies and TV series with multi-quality HLS streams (up to 4K)
//
// Uses the Nuvio provider (src/nuvio/videasy.cjs) which queries 10 speedracelight
// servers in parallel (Hydrogen, Titanium, Oxygen, Lithium, Krypton, Carbon,
// Aluminium, Nitrogen, Neon, Helium). Returns HLS URLs from moon.ironwallnet.net.
// Requires Referer: https://www.vidking.net/
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'movie'|'tv', season, episode)
//   3. Convert streams to Source result format via buildStreamResults()

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'videasy.cjs');

export class VidEasy extends Source {
  constructor(fetcher) {
    super();
    this.id = 'videasy';
    this.label = 'VidEasy';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://player.videasy.net';
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
      timeoutMs: 25000, // Videasy queries 10 servers, cap at 25s
    });

    // For anime (TV with season/episode), the audio is typically Japanese (sub).
    // For movies, default to English. VidEasy returns "Original Audio" which
    // means the original language — Japanese for anime, English for movies.
    const isAnime = !!tmdbId.season;
    const countryCodes = isAnime
      ? [CountryCode.multi, CountryCode.ja]
      : [CountryCode.multi, CountryCode.en];

    return buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes,
      ctx,
    });
  }
}
