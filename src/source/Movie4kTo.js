// src/source/Movie4kTo.js
// movie4kto.pro — TMDB-based movie/TV streaming site
//
// React SPA that uses TMDB IDs and embeds from multiple sources:
//   vidsrc-embed.ru, moviesapi.club, vidlink.pro, player.videasy.net,
//   111movies.com, player.vidzee.wtf, vidsrc.to
//
// Same pattern as CineWave/VidFast — pass meta.vidking for the VidKing
// extractor to resolve via speedracelight's TMDB-based API.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

// Embed sources used by movie4kto.pro (from JS bundle analysis)
const EMBED_SOURCES = [
  { label: 'VidSrc',    movie: 'https://vidsrc-embed.ru/embed/movie/{id}', tv: 'https://vidsrc-embed.ru/embed/tv/{id}/{s}/{e}' },
  { label: 'MoviesApi', movie: 'https://moviesapi.club/movie/{id}',        tv: 'https://moviesapi.club/tv/{id}-{s}-{e}' },
  { label: 'VidLink',   movie: 'https://vidlink.pro/movie/{id}',           tv: 'https://vidlink.pro/tv/{id}/{s}/{e}' },
  { label: 'Videasy',   movie: 'https://player.videasy.net/movie/{id}',    tv: 'https://player.videasy.net/tv/{id}/{s}/{e}' },
  { label: '111Movies', movie: 'https://111movies.com/movie/{id}',         tv: 'https://111movies.com/tv/{id}/{s}/{e}' },
  { label: 'Vidzee',    movie: 'https://player.vidzee.wtf/embed/movie/{id}', tv: 'https://player.vidzee.wtf/embed/tv/{id}?season={s}&episode={e}' },
  { label: 'VidSrcTo',  movie: 'https://vidsrc.to/embed/movie/{id}',       tv: 'https://vidsrc.to/embed/tv/{id}/{s}/{e}' },
];

export class Movie4kTo extends Source {
  constructor(fetcher) {
    super();
    this.id = 'movie4kto';
    this.label = 'Movie4kTo';
    // Movies only — Movie4kTo's embed sources are movie-focused.
    // The VidKing/speedracelight fallback returns wrong content for anime/TV
    // (e.g. movie streams showing for anime requests).
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://movie4kto.pro';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    const results = [];
    for (const source of EMBED_SOURCES) {
      const url = tmdbId.season
        ? source.tv.replace('{id}', tmdbId.id).replace('{s}', tmdbId.season).replace('{e}', tmdbId.episode)
        : source.movie.replace('{id}', tmdbId.id);

      results.push({
        url: new URL(url),
        meta: {
          countryCodes: [CountryCode.multi],
          title: `${title} (${source.label})`,
          vidking: vidkingMeta,
        },
      });
    }

    return results;
  }
}
