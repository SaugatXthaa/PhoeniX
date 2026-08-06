// src/source/CineWave.js
// CineWave (watch.cinewave.qzz.io) — movies/series/anime
// Uses 16+ embed sources with TMDB IDs, same as the CineWave website.
// When HdHub API returns donation-only, falls back to other embed sources.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

// All embed sources used by CineWave (from JS bundle analysis)
const EMBED_SOURCES = [
  { label: 'VidSrc', movie: 'https://vidsrc-embed.ru/embed/movie/{id}', tv: 'https://vidsrc-embed.ru/embed/tv/{id}/{s}/{e}' },
  { label: '2Embed', movie: 'https://2embed.cc/embed/movie/{id}', tv: 'https://2embed.cc/embed/tv/{id}&s={s}&e={e}' },
  { label: 'Vidzee', movie: 'https://player.vidzee.wtf/embed/movie/{id}', tv: 'https://player.vidzee.wtf/embed/tv/{id}?season={s}&episode={e}' },
  { label: 'VidFast', movie: 'https://vidfast.pro/movie/{id}', tv: 'https://vidfast.pro/tv/{id}/{s}/{e}' },
  { label: 'Videasy', movie: 'https://player.videasy.net/movie/{id}', tv: 'https://player.videasy.net/tv/{id}/{s}/{e}' },
  { label: 'Peachify', movie: 'https://peachify.top/embed/movie/{id}', tv: 'https://peachify.top/embed/tv/{id}?season={s}&episode={e}' },
  { label: 'CinemaOS', movie: 'https://cinemaos.tech/embed/movie/{id}', tv: 'https://cinemaos.tech/embed/tv/{id}?s={s}&e={e}' },
  { label: 'VidCore', movie: 'https://vidcore.net/embed/movie/{id}', tv: 'https://vidcore.net/embed/tv/{id}/{s}/{e}' },
  { label: 'VidKing', movie: 'https://vidking.net/embed/movie/{id}', tv: 'https://vidking.net/embed/tv/{id}/{s}/{e}' },
  { label: 'VidLux', movie: 'https://vidlux.xyz/embed/movie/{id}', tv: 'https://vidlux.xyz/embed/tv/{id}/{s}/{e}' },
  { label: 'Hexa', movie: 'https://hexa.su/embed/movie/{id}', tv: 'https://hexa.su/embed/tv/{id}/{s}/{e}' },
  { label: 'MappleTV', movie: 'https://mappletv.uk/embed/movie/{id}', tv: 'https://mappletv.uk/embed/tv/{id}/{s}/{e}' },
  { label: 'RiveStream', movie: 'https://rivestream.org/embed?type=movie&id={id}', tv: 'https://rivestream.org/embed?type=tv&id={id}&season={s}&episode={e}' },
  { label: 'AirFlix', movie: 'https://airflix1.com/movie/{id}', tv: 'https://airflix1.com/tv/{id}/{s}/{e}' },
  { label: 'FMovies', movie: 'https://fmovies.gd/movie/{id}', tv: 'https://fmovies.gd/tv/{id}?s={s}&e={e}' },
  { label: '111Movies', movie: 'https://111movies.net/movie/{id}', tv: 'https://111movies.net/tv/{id}?s={s}&e={e}' },
];

export class CineWave extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinewave';
    this.label = 'CineWave';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://watch.cinewave.qzz.io';
    this.priority = 1;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // HdHub API removed — it's donation-gated and only returns "Donation needed"
    // streams. CineWave now relies entirely on embed sources below, all of which
    // resolve via the VidKing extractor's speedracelight API fallback.

    // Embed sources (same as CineWave website)
    // All embed URLs get meta.vidking so the VidKing extractor can resolve
    // them via speedracelight's API (most have no dedicated extractor).
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
