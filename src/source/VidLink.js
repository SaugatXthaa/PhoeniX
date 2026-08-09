// src/source/VidLink.js
// vidlink.pro — TMDB-based movie/TV/anime streaming embed
//
// vidlink.pro uses TMDB IDs with JW Player. The stream URL is encrypted
// client-side using libsodium + WebAssembly — can't be resolved server-side.
// No meta.vidking — the speedracelight API is slow and returns wrong content
// for some titles. The embed URL is claimed by the VidKing extractor via
// the meta.vidking fallback, but we skip that to avoid slowness.
//
// URL patterns:
//   Movie: /movie/{tmdbId}
//   TV:    /tv/{tmdbId}/{season}/{episode}

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class VidLink extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vidlink2';
    this.label = 'VidLink';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://vidlink.pro';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const url = tmdbId.season
      ? new URL(`/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl)
      : new URL(`/movie/${tmdbId.id}`, this.baseUrl);

    // Pass meta.vidking for movies only — the speedracelight API resolves
    // streams for the vidlink.pro embed (which uses WASM encryption and
    // can't be extracted server-side). Without it, VidLink produces 0 streams.
    // For series/anime, speedracelight returns wrong content — skip it.
    const vidkingMeta = tmdbId.season ? null : {
      name,
      year,
      tmdbId: tmdbId.id,
    };

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title,
        ...(vidkingMeta && { vidking: vidkingMeta }),
      },
    }];
  }
}
