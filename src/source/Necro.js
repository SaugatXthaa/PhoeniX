// src/source/Necro.js
// necro.pages.dev — TMDB-based movie/TV/anime streaming with embed sources
//
// Uses TMDB IDs and embeds from multiple sources:
//   VidSrc.me, 2Embed, VidSrc.to, Embed.su, MultiEmbed
//
// Same pattern as CineWave — embed URLs resolved via VidKing extractor's
// speedracelight API (meta.vidking fallback).

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const EMBED_SOURCES = [
  { label: 'VidSrc',    movie: 'https://vidsrc.me/embed/movie?tmdb={id}',  tv: 'https://vidsrc.me/embed/tv?tmdb={id}&season={s}&episode={e}' },
  { label: '2Embed',    movie: 'https://www.2embed.cc/embed/{id}',          tv: 'https://www.2embed.cc/embedtv/{id}&s={s}&e={e}' },
  { label: 'VidSrcTo',  movie: 'https://vidsrc.to/embed/movie/{id}',        tv: 'https://vidsrc.to/embed/tv/{id}/{s}/{e}' },
  { label: 'EmbedSu',   movie: 'https://embed.su/embed/movie/{id}',         tv: 'https://embed.su/embed/tv/{id}/{s}/{e}' },
  { label: 'MultiEmbed', movie: 'https://multiembed.mov/directstream.php?video_id={id}&tmdb=1&srv=vipstream-s', tv: 'https://multiembed.mov/directstream.php?video_id={id}&tmdb=1&s={s}&e={e}&srv=vipstream-s' },
];

export class Necro extends Source {
  constructor(fetcher) {
    super();
    this.id = 'necro';
    this.label = 'Necro';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://necro.pages.dev';
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
