// src/source/CineHDPlus.js
// Ported from research/webstreamr-mbg/src/source/CineHDPlus.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

export class CineHDPlus extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinehdplus';
    this.label = 'CineHDPlus';
    this.contentTypes = ['series'];
    this.countryCodes = [CountryCode.es, CountryCode.mx];
    this.baseUrl = 'https://cinehdplus.zone';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    let name, year;
    try {
      [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, 'es');
    } catch {
      return [];
    }

    const seriesPageUrl = await this.fetchSeriesPageUrl(ctx, name);
    if (!seriesPageUrl) {
      return [];
    }

    const html = await this.fetcher.text(ctx, seriesPageUrl);

    const $ = cheerio.load(html);

    const countryCodes = [($('.details__langs').html()).includes('Latino') ? CountryCode.mx : CountryCode.es];

    const title = `${($('meta[property="og:title"]').attr('content')).trim()} ${tmdbId.formatSeasonAndEpisode()}`;

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    return Promise.all(
      $(`[data-num="${tmdbId.season}x${tmdbId.episode}"]`)
        .siblings('.mirrors')
        .children('[data-link]')
        .map((_i, el) => new URL(($(el).attr('data-link')).replace(/^(https:)?\/\//, 'https://')))
        .toArray()
        .filter(url => !url.host.match(/cinehdplus/))
        .map(url => ({ url, meta: { countryCodes, referer: seriesPageUrl.href, title, vidking: vidkingMeta } })),
    );
  }

  // Case-insensitive match handles TMDB/CineHDPlus capitalization differences (e.g. "La casa de dragón" vs "La Casa del Dragón")
  async fetchSeriesPageUrl(ctx, name) {
    const html = await this.fetcher.text(ctx, new URL(`/series/?story=${encodeURIComponent(name)}&do=search&subaction=search`, this.baseUrl));

    const $ = cheerio.load(html);

    const url = $('.card__title a[href]')
      .filter((_i, el) => $(el).text().trim().toLowerCase() === name.toLowerCase())
      .attr('href');

    return url !== undefined ? new URL(url) : url;
  }
}
