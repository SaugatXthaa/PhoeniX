// src/source/Cuevana.js
// Ported from research/webstreamr-mbg/src/source/Cuevana.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class Cuevana extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cuevana';
    this.label = 'Cuevana';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.es, CountryCode.mx];
    this.baseUrl = 'https://ww1.cuevana3.is';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, 'es');

    let pageUrl = await this.fetchPageUrl(ctx, name);
    if (!pageUrl) {
      return [];
    }

    let title = name;

    if (tmdbId.season) {
      title += ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}`;

      pageUrl = await this.fetchEpisodeUrl(ctx, pageUrl, tmdbId);
      if (!pageUrl) {
        return [];
      }
    } else {
      title += ` (${year})`;
    }

    const html = await this.fetcher.text(ctx, pageUrl);
    const $ = cheerio.load(html);

    const vidkingMeta = tmdbId.season ? null : { name, year, tmdbId: tmdbId.id };

    const urlResults = $('.open_submenu')
      .map((_i, el) => {
        const elText = $(el).text();
        if (!elText.includes('Español')) {
          return [];
        }

        if (elText.includes('Latino')) {
          return $('[data-tr], [data-video]', el)
            .map((_i, el) => ({
              url: new URL($(el).attr('data-tr') ?? $(el).attr('data-video')),
              meta: { countryCodes: [CountryCode.mx], referer: pageUrl.href, title, ...(vidkingMeta && { vidking: vidkingMeta }) },
            }))
            .toArray();
        }

        return $('[data-tr], [data-video]', el)
          .map((_i, el) => ({
            url: new URL($(el).attr('data-tr') ?? $(el).attr('data-video')),
            meta: { countryCodes: [CountryCode.es], referer: pageUrl.href, title, ...(vidkingMeta && { vidking: vidkingMeta }) },
          }))
          .toArray();
      })
      .toArray();

    return Promise.all(
      urlResults.map(async ({ url, meta }) => {
        if (!url.host.includes('cuevana3')) {
          return { url, meta };
        }

        const html = await this.fetcher.text(ctx, url, { headers: { Referer: pageUrl.origin } });

        const urlMatcher = html.match(/url ?= ?'(.*)'/);

        return { url: new URL(urlMatcher[1]), meta };
      }),
    );
  }

  async fetchPageUrl(ctx, keyword) {
    const searchUrl = new URL(`/search/${encodeURIComponent(keyword)}/`, this.baseUrl);
    const html = await this.fetcher.text(ctx, searchUrl, { headers: { Referer: searchUrl.origin } });

    const $ = cheerio.load(html);

    const urlPath = $('.TPost .Title')
      .filter((_i, el) => $(el).text().trim() === keyword)
      .closest('a')
      .attr('href');

    return urlPath !== undefined ? new URL(urlPath, searchUrl.origin) : urlPath;
  }

  async fetchEpisodeUrl(ctx, pageUrl, tmdbId) {
    const html = await this.fetcher.text(ctx, pageUrl, { headers: { Referer: pageUrl.origin } });

    const $ = cheerio.load(html);

    const urlPath = $('.TPost .Year')
      .filter((_i, el) => $(el).text().trim() === `${tmdbId.season}x${tmdbId.episode}`)
      .closest('a')
      .attr('href');

    return urlPath !== undefined ? new URL(urlPath, pageUrl.origin) : urlPath;
  }
}
