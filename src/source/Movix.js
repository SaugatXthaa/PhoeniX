// src/source/Movix.js
// Ported from research/webstreamr-mbg/src/source/Movix.ts

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class Movix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'movix';
    this.label = 'Movix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.fr];
    this.baseUrl = 'https://api.movix.cash';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const apiUrl = tmdbId.season
      ? new URL(`/api/tmdb/tv/${tmdbId.id}?season=${tmdbId.season}&episode=${tmdbId.episode}`, this.baseUrl)
      : new URL(`/api/tmdb/movie/${tmdbId.id}`, this.baseUrl);

    const json = await this.fetcher.json(ctx, apiUrl, {
      headers: {
        Origin: 'https://movix.cash',
        Referer: 'https://movix.cash/',
      },
    });
    const data = tmdbId.season ? json['current_episode'] : json;

    if (!data || !data.player_links) {
      return [];
    }

    const urls = data['player_links'].map(({ decoded_url }) => new URL(decoded_url));

    const title = tmdbId.season
      ? `${json['tmdb_details']?.['title'] ?? 'Unknown'} ${TmdbId.formatSeasonAndEpisode(tmdbId)}`
      : `${json['tmdb_details']?.['title'] ?? 'Unknown'} (${year})`;

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    return urls.map(url => ({ url, meta: { countryCodes: [CountryCode.fr], referer: data.iframe_src, title, vidking: vidkingMeta } }));
  }
}
