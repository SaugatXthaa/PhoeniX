// src/source/AnimeWorldIN.js
// animeworld (India) — watchanimeworld.one — anime + cartoons + anime movies
//
// Uses the Nuvio provider (src/nuvio/animeworld.cjs) which scrapes
// watchanimeworld.one and returns the play.zephyrix.org (FirePlayer)
// multi-audio master.m3u8 (Japanese/English/Telugu/Tamil/Hindi audio,
// 240p→1080p — Task 68 measured; the site has no 4K tier).
//
// ID is 'animeworldindia' to avoid conflict with existing 'animeworld' source
// (which is the German anime-world.scfe-clan.net site).
//
// Task 68 re-reverse-engineering (the site stopped CF-blocking datacenter
// egress on the .one domain):
//   - Flow: search /?s=<title> → /series|/movies/<slug> post → (series)
//     admin-ajax action_select_season → /episode/<slug>-<S>x<E> → zephyrix
//     getVideo POST → signed master.m3u8.
//   - Delivery: master + variant playlists + grid CDN segments all REQUIRE
//     Referer: https://play.zephyrix.org/ and the CDN 403s datacenter IPs in
//     temporal windows — the card ships DIRECT with behaviorHints.proxyHeaders
//     (meta.nuvioDirectWithHeaders) so the PLAYER's IP makes the request,
//     exactly like the site's own browser player (workers.dev class).
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, type, season, episode)
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
    // Task 68: the site serves anime/cartoon SERIES posts AND anime MOVIE
    // posts (verified: /movies/jujutsu-kaisen-0/ → same zephyrix flow) —
    // enable movies. NOT a general kdrama/cdrama source: the site has no
    // kdrama category (404) and no live-action catalog.
    this.contentTypes = ['series', 'movie'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = 'https://watchanimeworld.one';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const isSeries = !!tmdbId.season;
    const title = name + (isSeries ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mediaType = isSeries ? 'tv' : 'movie';
    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType,
      season: tmdbId.season || undefined,
      episode: tmdbId.episode || undefined,
      timeoutMs: 25000, // stay under 30s source timeout
    });

    const results = buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });

    // Task 68 delivery: zephyrix master/variants/segments need
    // Referer: https://play.zephyrix.org/ and the CDN 403s datacenter egress
    // in temporal windows — /proxy would fetch from OUR blocked IP. Ship
    // DIRECT with requestHeaders (NuvioExtractor → behaviorHints.proxyHeaders)
    // so the client's residential IP makes the request, same as the real
    // browser player. NO Origin header: measured 403 with Origin on some
    // windows, 200 with Referer-only + UA.
    for (const r of results) {
      if (r.meta) r.meta.nuvioDirectWithHeaders = true;
    }

    return results;
  }
}
