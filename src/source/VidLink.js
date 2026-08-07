// src/source/VidLink.js
// vidlink.pro — TMDB-based movie/TV/anime streaming embed
//
// vidlink.pro uses TMDB IDs with JW Player. The stream URL is encrypted
// client-side using libsodium + WebAssembly — can't be resolved server-side.
// We pass meta.vidking for the VidKing extractor to resolve via speedracelight.
//
// URL patterns:
//   Movie: /movie/{tmdbId}
//   TV:    /tv/{tmdbId}/{season}/{episode}
//
// VidLink is specifically good for anime streaming (sub + dub support).

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

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title,
        vidking: vidkingMeta,
      },
    }];
  }
}
