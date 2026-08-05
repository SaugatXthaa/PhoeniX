// src/source/KinoGer.js
// Ported from research/webstreamr-mbg/src/source/KinoGer.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

export class KinoGer extends Source {
  constructor(fetcher) {
    super();
    this.id = 'kinoger';
    this.label = 'KinoGer';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.de];
    this.baseUrl = 'https://kinoger.com';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, 'de');

    const pageUrl = await this.fetchPageUrl(ctx, name, year);
    if (!pageUrl) {
      return [];
    }

    const title = tmdbId.season ? `${name} ${tmdbId.season}x${tmdbId.episode}` : `${name} (${year})`;
    const seasonIndex = (tmdbId.season ?? 1) - 1;
    const episodeIndex = (tmdbId.episode ?? 1) - 1;

    const html = await this.fetcher.text(ctx, pageUrl);

    return Array.from(html.matchAll(/\.show\(.*/g))
      .map(showJsMatch => this.findEpisodeUrlInShowJs(showJsMatch[0], seasonIndex, episodeIndex))
      .filter((url) => url !== undefined)
      .map(url => ({ url, meta: { countryCodes: [CountryCode.de], referer: pageUrl.href, title } }));
  }

  findEpisodeUrlInShowJs(showJs, seasonIndex, episodeIndex) {
    let episodeUrl;

    showJs.matchAll(/\[(.*?)]/g).forEach((urlsMatch, season) => {
      if (season !== seasonIndex || !urlsMatch[1]) {
        return;
      }

      const urlMatch = (urlsMatch[1].split(',')[episodeIndex] ?? '').match(/https?:\/\/[^\s'"<>]+/);
      if (!urlMatch) {
        return;
      }

      episodeUrl = new URL(urlMatch[0]);
    });

    return episodeUrl;
  }

  async fetchPageUrl(ctx, keyword, year) {
    const searchUrl = new URL(`/?do=search&subaction=search&titleonly=3&story=${encodeURIComponent(keyword)}&x=0&y=0&submit=submit`, this.baseUrl);

    const html = await this.fetcher.text(ctx, searchUrl);

    const $ = cheerio.load(html);

    return $(`.title a:contains("${year}")`)
      .map((_i, el) => new URL($(el).attr('href'), this.baseUrl))
      .get(0);
  }
}
