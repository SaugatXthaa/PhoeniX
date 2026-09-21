// src/source/Antarctica.js
// antarctica — movies/series/anime via comet.feels.legal (Antarctica, a Comet
// fork) over the TorBox debrid cache. Task 77.
//
// The provider (src/nuvio/antarctica.cjs) rebuilds the Antarctica config with
// the active TorBox key and calls the addon's /stream/{movie|series}/
// <imdb>[:s:e].json endpoint. cachedOnly:true + enableTorrent:false in that
// config guarantee every returned stream is an HTTPS direct URL for a torrent
// TorBox has ALREADY cached — zero magnets (rules.md §A1), zero torrent client.
//
// Measured (Task 77, sandbox): Inception 237 raw streams in 1.4s; BB S01E1
// 88; playback URL Range-probe → 302 → nexus-114.japn.tb-cdn.pw → 206,
// accept-ranges: bytes, EBML magic = real MKV. Playback URLs are
// deterministic (config+hash+idx) and do not expire while cached.
//
// Routing: URLs are extension-less comet.feels.legal/playback/... with a
// User-Agent header and NO Referer → buildStreamResults sets nuvioProvider +
// nuvioUserAgent, and NuvioExtractor's no-Referer branch ships them DIRECT
// (format mp4, player's own IP fetches, no Render hop). Requires
// 'antarctica' in NuvioExtractor's NUVIO_SOURCE_IDS (else cards match no
// extractor and silently drop — Task 25 class).
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'movie'|'tv', season, episode)
//      (provider resolves TMDB→IMDB internally — Antarctica requires IMDB)
//   3. Convert streams to Source result format via buildStreamResults()

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider, withRetryOnEmpty } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'antarctica.cjs');

export class Antarctica extends Source {
  constructor(fetcher) {
    super();
    this.id = 'antarctica';
    this.label = 'Antarctica';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://comet.feels.legal';
    this.fetcher = fetcher;
    // 10min — playback URLs are deterministic and do not expire while the
    // torrent stays TorBox-cached; 10min matches the source family and keeps
    // cache lists reflecting fresh TorBox cache lookups.
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    // Task 77: bounded retry — the throttled sandbox caught a transient
    // TMDB/DNS blip zeroing the whole provider in ~2s (fast-fail signature,
    // not a timeout), while the SAME code returned 50 cards @2.4s on the
    // next run. Same hardening as uhdmovies/bollyflix/stellar (Task 38):
    // attempt 2 absorbs the blip; worst case 2×2.4s, well inside the 25s
    // provider race cap.
    const streams = await withRetryOnEmpty(
      () => callNuvioProvider(PROVIDER_PATH, {
        tmdbId: tmdbId.id,
        mediaType,
        season: tmdbId.season || null,
        episode: tmdbId.episode || null,
      }),
      { attempts: 2, maxTotalMs: 15000, tag: 'antarctica' }
    );

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
