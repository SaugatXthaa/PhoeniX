// src/source/Kokoshka.js
// Ported from research/webstreamr-mbg/src/source/Kokoshka.ts

import * as cheerio from 'cheerio';
import levenshtein from 'fast-levenshtein';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

export class Kokoshka extends Source {
  constructor(fetcher) {
    super();
    this.id = 'kokoshka';
    this.label = 'Kokoshka';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.al];
    this.baseUrl = 'https://kokoshka.digital';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    let pageUrl = await this.fetchPageUrl(ctx, tmdbId, 'sq');
    if (!pageUrl) {
      pageUrl = await this.fetchPageUrl(ctx, tmdbId, 'en');
      if (!pageUrl) {
        return [];
      }
    }

    if (tmdbId.season) {
      pageUrl = await this.fetchEpisodeUrl(ctx, pageUrl, tmdbId);
      if (!pageUrl) {
        return [];
      }
    }

    const pageHtml = await this.fetcher.text(ctx, pageUrl);

    const $ = cheerio.load(pageHtml);

    const title = $('title').first().text().trim();

    const vidkingMeta = tmdbId.season ? null : { name, year, tmdbId: tmdbId.id };

    return Promise.all(
      $('.dooplay_player_option:not(#player-option-trailer)')
        .map(async (_i, el) => {
          const post = parseInt($(el).attr('data-post'));
          const type = $(el).attr('data-type');
          const nume = parseInt($(el).attr('data-nume'));

          const dooplayerUrl = new URL(`/wp-json/dooplayer/v2/${post}/${type}/${nume}`, this.baseUrl);
          const dooplayerResponse = await this.fetcher.json(ctx, dooplayerUrl, { headers: { Referer: pageUrl.href } });

          return {
            url: new URL(dooplayerResponse.embed_url),
            meta: {
              countryCodes: [CountryCode.al],
              referer: pageUrl.href,
              title,
              ...(vidkingMeta && { vidking: vidkingMeta }),
            },
          };
        })
        .toArray(),
    );
  }

  async fetchPageUrl(ctx, tmdbId, language) {
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, language);

    const searchUrl = new URL(`/?s=${encodeURIComponent(`${name.replace(':', '')} ${year}`)}`, this.baseUrl);
    const html = await this.fetcher.text(ctx, searchUrl);

    const $ = cheerio.load(html);

    return $(`.result-item:has(${tmdbId.season ? '.tvshows' : '.movies'})`)
      .filter((_i, el) => {
        const resultItemYear = parseInt($('.year', el).text());
        return Math.abs(resultItemYear - year) <= 1;
      })
      .filter((_i, el) => {
        const resultItemTitle = $('.title', el)
          .text()
          .replace(/\(\d+\).*/, '')
          .trim();

        return levenshtein.get(resultItemTitle, name, { useCollator: true }) < 3;
      })
      .map((_i, el) => new URL($('a', el).attr('href'), this.baseUrl))
      .get(0);
  }

  async fetchEpisodeUrl(ctx, pageUrl, tmdbId) {
    const html = await this.fetcher.text(ctx, pageUrl);

    const $ = cheerio.load(html);

    return $(`.episodiotitle a[href*="${tmdbId.season}x${tmdbId.episode}"]`)
      .map((_i, el) => new URL($(el).attr('href'), this.baseUrl))
      .get(0);
  }
}
