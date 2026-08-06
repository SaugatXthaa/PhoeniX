// src/source/Frembed.js
// Ported from research/webstreamr-mbg/src/source/Frembed.ts

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class Frembed extends Source {
  constructor(fetcher) {
    super();
    this.id = 'frembed';
    this.label = 'Frembed';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.fr];
    this.baseUrl = 'https://frembed.cyou';
    this.fetcher = fetcher;

    // Simple in-memory memoization (1h TTL) replacing memoizee
    this._baseUrlCache = null;
    this._baseUrlCacheTs = 0;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const baseUrl = await this.getBaseUrl(ctx);

    const apiUrl = tmdbId.season
      ? new URL(`/api/series?id=${tmdbId.id}&sa=${tmdbId.season}&epi=${tmdbId.episode}&idType=tmdb`, baseUrl)
      : new URL(`/api/films?id=${tmdbId.id}&idType=tmdb`, baseUrl);

    const json = await this.fetcher.json(ctx, apiUrl, { headers: { Referer: baseUrl.origin } });

    const urls = [];
    for (const key in json) {
      if (key.startsWith('link') && json[key] && !json[key].includes(',https')) {
        try {
          urls.push(await this.fetcher.getFinalRedirectUrl(ctx, new URL(json[key].trim(), baseUrl), { headers: { Referer: baseUrl.origin + '/' } }));
        } catch {
          // Skip invalid URL
        }
      }
    }

    const title = tmdbId.season
      ? `${json['title']} ${TmdbId.formatSeasonAndEpisode(tmdbId)}`
      : `${json['title']} (${year})`;

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    return urls.map(url => ({ url, meta: { countryCodes: [CountryCode.fr], referer: baseUrl.origin, title, vidking: vidkingMeta } }));
  }

  async getBaseUrl(ctx) {
    if (this._baseUrlCache && Date.now() - this._baseUrlCacheTs < 3600000) {
      return this._baseUrlCache;
    }
    const url = await this.fetcher.getFinalRedirectUrl(ctx, new URL(this.baseUrl));
    this._baseUrlCache = url;
    this._baseUrlCacheTs = Date.now();
    return url;
  }
}
