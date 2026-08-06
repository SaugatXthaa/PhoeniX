// src/source/HomeCine.js
// Ported from research/webstreamr-mbg/src/source/HomeCine.ts

import * as cheerio from 'cheerio';
import levenshtein from 'fast-levenshtein';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class HomeCine extends Source {
  constructor(fetcher) {
    super();
    this.id = 'homecine';
    this.label = 'HomeCine';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.es, CountryCode.mx];
    this.baseUrl = 'https://www3.homecine.to';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    const [name, year, originalName] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, 'es');

    let pageUrl = await this.fetchPageUrl(ctx, name, tmdbId);
    if (!pageUrl) {
      pageUrl = await this.fetchPageUrl(ctx, originalName, tmdbId);
      if (!pageUrl) {
        return [];
      }
    }

    let pageHtml = await this.fetcher.text(ctx, pageUrl);

    if (tmdbId.season) {
      const episodePageUrl = await this.fetchEpisodeUrl(pageHtml, tmdbId);
      if (!episodePageUrl) {
        return [];
      }

      pageUrl = episodePageUrl;
      pageHtml = await this.fetcher.text(ctx, pageUrl);
    }

    const title = tmdbId.season ? `${name} ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : `${name} (${year})`;

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    const $ = cheerio.load(pageHtml);

    return $('.les-content a')
      .map((_i, el) => {
        let countryCodes;
        if ($(el).text().toLowerCase().includes('latino')) {
          countryCodes = [CountryCode.mx];
        } else if ($(el).text().toLowerCase().includes('castellano')) {
          countryCodes = [CountryCode.es];
        } else {
          return [];
        }

        return {
          url: new URL($('iframe', $(el).attr('href')).attr('src')),
          meta: { countryCodes, referer: pageUrl.href, title, vidking: vidkingMeta },
        };
      }).toArray();
  }

  async fetchPageUrl(ctx, name, tmdbId) {
    const searchUrl = new URL(`/?s=${encodeURIComponent(name)}`, this.baseUrl);

    const html = await this.fetcher.text(ctx, searchUrl);

    const $ = cheerio.load(html);

    const keywords = [...new Set([
      name,
      name.replace('-', '–'),
    ])];

    const urls = [];

    // exact match
    keywords.map((keyword) => {
      urls.push(
        ...$(`a[oldtitle="${keyword}"]`)
          .map((_i, el) => new URL($(el).attr('href')))
          .toArray()
          .filter(url => tmdbId.season ? url.href.includes('/series/') : !url.href.includes('/series/')),
      );
    });

    // similar match
    keywords.map((keyword) => {
      urls.push(
        ...$(`a[oldtitle]`)
          .filter((_i, el) => levenshtein.get(($(el).attr('oldtitle')).trim(), keyword, { useCollator: true }) < 5)
          .map((_i, el) => new URL($(el).attr('href')))
          .toArray()
          .filter(url => tmdbId.season ? url.href.includes('/series/') : !url.href.includes('/series/')),
      );
    });

    return urls[0];
  }

  async fetchEpisodeUrl(pageHtml, tmdbId) {
    const $ = cheerio.load(pageHtml);

    const urls = $('#seasons a')
      .map((_i, el) => new URL($(el).attr('href')))
      .toArray()
      .filter(url => url.href.endsWith(`-temporada-${tmdbId.season}-capitulo-${tmdbId.episode}`));

    return urls[0];
  }
}
