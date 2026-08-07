// src/source/WatchSeries.js
// watchseries.lc — TMDB-based movie/TV streaming with 14 server options
//
// Uses TMDB IDs with server selection via ?server= query param.
// Each server returns a different embed iframe (vidsrc.mov, vidsrc.fyi, etc.)
// Same pattern as CineWave — embed URLs resolved via VidKing extractor's
// speedracelight API (meta.vidking fallback).

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

// Server → embed URL mapping (from JS bundle analysis)
const SERVERS = [
  { key: 'vidsrcto',   label: 'VidSrc',    movie: 'https://vidsrc.mov/embed/movie/{id}',              tv: 'https://vidsrc.mov/embed/tv/{id}/{s}/{e}' },
  { key: 'vidsrcfyi',  label: 'VidSrc.fyi', movie: 'https://vidsrc.fyi/embed/movie/{id}',             tv: 'https://vidsrc.fyi/embed/tv/{id}/{s}/{e}' },
  { key: 'vidrock',    label: 'VidRock',    movie: 'https://vidrock.net/movie/{id}',                   tv: 'https://vidrock.net/tv/{id}/{s}/{e}' },
  { key: 'vidnest',    label: 'Vidnest',    movie: 'https://vidnest.fun/movie/{id}',                   tv: 'https://vidnest.fun/tv/{id}/{s}/{e}' },
  { key: 'vidking',    label: 'VidKing',    movie: 'https://www.vidking.net/embed/movie/{id}',         tv: 'https://www.vidking.net/embed/tv/{id}/{s}/{e}' },
  { key: 'vidlink',    label: 'VidLink',    movie: 'https://vidlink.pro/movie/{id}?autoplay=true&title=true', tv: 'https://vidlink.pro/tv/{id}/{s}/{e}?autoplay=true&title=true' },
  { key: 'vidfast',    label: 'VidFast',    movie: 'https://vidfast.pro/movie/{id}?autoPlay=true',     tv: 'https://vidfast.pro/tv/{id}/{s}/{e}?autoPlay=true' },
  { key: '2embed',     label: '2Embed',     movie: 'https://www.2embed.cc/embed/{id}',                 tv: 'https://www.2embed.cc/embedtv/{id}&s={s}&e={e}' },
  { key: 'multiembed', label: 'MultiEmbed', movie: 'https://multiembed.mov/?video_id={id}&tmdb=1',     tv: 'https://multiembed.mov/?video_id={id}&tmdb=1&s={s}&e={e}' },
  { key: 'superflix',  label: 'SuperFlix',  movie: 'https://superflixapi.co/filme/{id}',               tv: 'https://superflixapi.co/serie/{id}/{s}/{e}' },
  { key: 'peachify',   label: 'Peachify',   movie: 'https://peachify.top/embed/movie/{id}',            tv: 'https://peachify.top/embed/tv/{id}?season={s}&episode={e}' },
];

export class WatchSeries extends Source {
  constructor(fetcher) {
    super();
    this.id = 'watchseries';
    this.label = 'WatchSeries';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://watchseries.lc';
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
    for (const server of SERVERS) {
      const url = tmdbId.season
        ? server.tv.replace('{id}', tmdbId.id).replace('{s}', tmdbId.season).replace('{e}', tmdbId.episode)
        : server.movie.replace('{id}', tmdbId.id);

      results.push({
        url: new URL(url),
        meta: {
          countryCodes: [CountryCode.multi],
          title: `${title} (${server.label})`,
          vidking: vidkingMeta,
        },
      });
    }

    return results;
  }
}
