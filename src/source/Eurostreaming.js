// src/source/Eurostreaming.js
// Ported from research/webstreamr-mbg/src/source/Eurostreaming.ts

import * as cheerio from 'cheerio';
import levenshtein from 'fast-levenshtein';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class Eurostreaming extends Source {
  constructor(fetcher) {
    super();
    this.id = 'eurostreaming';
    this.label = 'Eurostreaming';
    this.contentTypes = ['series'];
    this.countryCodes = [CountryCode.it];
    this.baseUrl = 'https://eurostreaming.luxe';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, 'it');

    const seriesPageUrl = await this.fetchSeriesPageUrl(ctx, name.replace(':', '').replace('-', ''));
    if (!seriesPageUrl) {
      return [];
    }

    const html = await this.fetcher.text(ctx, seriesPageUrl);

    const $ = cheerio.load(html);

    const title = `${name} ${TmdbId.formatSeasonAndEpisode(tmdbId)}`;

    const vidkingMeta = {
      name,
      year: undefined,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    return Promise.all(
      $(`[data-num="${tmdbId.season}x${tmdbId.episode}"]`)
        .siblings('.mirrors')
        .children('[data-link!="#"]')
        .map((_i, el) => new URL($(el).attr('data-link')))
        .toArray()
        .filter(url => !url.host.match(/eurostreaming/))
        .map(url => ({ url, meta: { countryCodes: [CountryCode.it], referer: seriesPageUrl.href, title, ...(vidkingMeta && { vidking: vidkingMeta }) } })),
    );
  }

  async fetchSeriesPageUrl(ctx, keyword) {
    const postUrl = new URL('/index.php?do=search', this.baseUrl);

    const form = new URLSearchParams();
    form.append('subaction', 'search');
    form.append('story', keyword);

    const html = await this.fetcher.textPost(
      ctx,
      postUrl,
      form.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': postUrl.origin,
        },
      },
    );

    const $ = cheerio.load(html);

    const exactKeyWordMatchUrl = $(`.post-thumb a[href][title="${keyword}"]:first`)
      .map((_i, el) => new URL($(el).attr('href')))
      .get(0);

    const similarKeyWordMatchUrl = $(`.post-thumb a[href]:first`)
      .filter((_i, el) => levenshtein.get(($(el).attr('title')).trim(), keyword, { useCollator: true }) < 5)
      .map((_i, el) => new URL($(el).attr('href')))
      .get(0);

    const partialKeyWordMatchUrl = $(`.post-thumb a[href][title*="${keyword}"]:first`)
      .map((_i, el) => new URL($(el).attr('href')))
      .get(0);

    return exactKeyWordMatchUrl ?? similarKeyWordMatchUrl ?? partialKeyWordMatchUrl;
  }
}
