// src/source/HindMoviez.js
// hindmoviez — movies and TV series (Hindi/English) with 4K and 1080p streams
//
// Uses the Nuvio provider (src/nuvio/hindmoviez.cjs) which scrapes hshare.ink
// and hcloud.ink, returning direct MKV URLs from *.workers.dev CDNs.
// No Referer required (workers.dev URLs are direct-playable).
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Call provider.getStreams(tmdbId, 'movie'|'tv', season, episode)
//   3. Convert streams to Source result format via buildStreamResults()
//
// Note: hindmoviez is slower (15-40s) due to multiple hshare.ink API calls.
// The provider timeout is set to 40s to accommodate this.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider, filterDeadStreams } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'hindmoviez.cjs');

export class HindMoviez extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hindmoviez';
    this.label = 'HindMoviez';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://hindmoviez.ink';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    // Task 22 live-measured: scraper wall ≈20s (3 MvLink waves × hshare+hcloud
    // fetches) + liveness probes ≈1-3s. The old 25s provider cap raced the
    // scraper's own completion and zeroed the source. 30s keeps the whole
    // chain inside the resolver's 35s per-source cutoff.
    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      timeoutMs: 30000,
    });

    // Liveness gate — definitive 4xx/5xx/HTML responses still drop. Task 65:
    // network-timeouts no longer do. Live evidence: the hindmoviez worker CDN
    // (my.mainone0hindmoviezday.workers.dev) serves 200 video/x-matroska in
    // 1.8s from device-class IPs but TARPITS the Render datacenter IP (no
    // headers in >12s) — the old probe read that as death and dropped every
    // card → production honest-zero while the chain itself was healthy. The
    // player fetches the worker URL directly (device IP, no /proxy hop), so a
    // Render-side stall says nothing about user-side playability.
    // Task 71 (2026-09-21): the worker family upgraded the datacenter gate
    // from tarpit to FAIL-FAST 401 (15/15 URLs answered 401 in ~1s from
    // Render while the chain resolved real files). Same IP-class design as
    // Task 65 measured — device IPs still serve the files. 401/403 from these
    // workers are declared ip-class so the cards keep shipping; everything
    // else (404/5xx/html) still drops definitively.
    const liveStreams = await filterDeadStreams(streams, { dropOnNetworkError: false, ipClassStatuses: [401, 403] });

    return buildStreamResults({
      streams: liveStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
