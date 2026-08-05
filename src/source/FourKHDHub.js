// src/source/FourKHDHub.js
// Ported from research/webstreamr-mbg/src/source/FourKHDHub.ts

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import Fuse from 'fuse.js';
import { CountryCode } from '../types.js';
import { DEAD_HUBCLOUD_HOSTS, findCountryCodes, getTmdbId, getTmdbNameAndYear, HUB_HOST_PATTERN } from '../utils/index.js';
import { resolveRedirectUrl } from './hd-hub-helper.js';
import { Source } from './Source.js';

const PIXEL_PATTERNS = /pixel\.(hubcdn|rohitkiskk)/;

export class FourKHDHub extends Source {
  constructor(fetcher) {
    super();
    this.id = '4khdhub';
    this.label = '4KHDHub';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.ta, CountryCode.te];
    this.baseUrl = 'https://4khdhub.link';
    this.domainKey = '4kHDHub';
    this.fetcher = fetcher;
    this.FALLBACK_CANDIDATES = [
      'https://4khdhub.link',
      'https://4khdhub.click',
      'https://4khdhub.ink',
      'https://4khdhub.one',
      'https://4khdhub.to',
      'https://4khdhub.cc',
    ];
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    const pageUrl = await this.fetchPageUrl(ctx, tmdbId);
    if (!pageUrl) {
      return [];
    }

    const html = await this.fetcher.text(ctx, pageUrl);
    const $ = cheerio.load(html);

    if (tmdbId.season) {
      const results = await Promise.all(
        $(`.episode-item`)
          .filter((_i, el) => $('.episode-title', el).text().includes(`S${String(tmdbId.season).padStart(2, '0')}`))
          .map((_i, el) => ({
            countryCodes: [CountryCode.multi, ...findCountryCodes($(el).html())],
            downloadItem: $('.episode-download-item', el)
              .filter((_i, el) => $(el).text().includes(`Episode-${String(tmdbId.episode).padStart(2, '0')}`))
              .get(0),
          }))
          .filter((_i, { downloadItem }) => downloadItem !== undefined)
          .map(async (_id, { countryCodes, downloadItem }) => await this.extractSourceResults(ctx, $, downloadItem, countryCodes))
          .toArray(),
      );
      return results.flat();
    }

    const results = await Promise.all(
      $(`.download-item`)
        .map(async (_i, el) => await this.extractSourceResults(ctx, $, el, [CountryCode.multi, ...findCountryCodes($(el).html())]))
        .toArray(),
    );
    return results.flat();
  }

  async fetchPageUrl(ctx, tmdbId) {
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const searchUrl = new URL(`/?s=${encodeURIComponent(name)}`, await this.getBaseUrl(ctx));
    const html = await this.fetcher.text(ctx, searchUrl);

    const $ = cheerio.load(html);

    const typeSlug = tmdbId.season ? '-series-' : '-movie-';

    return $(`.movie-card`)
      .filter((_i, el) => {
        const href = String($(el).attr('href'));
        return href.includes(typeSlug);
      })
      .filter((_i, el) => {
        const movieCardYear = parseInt($('.movie-card-meta', el).text());
        return Math.abs(movieCardYear - year) <= 1;
      })
      .filter((_i, el) => {
        const movieCardTitle = $('.movie-card-title', el)
          .text()
          .replace(/\[.*?]/, '')
          .trim();

        const fuse = new Fuse([movieCardTitle], { threshold: 0.3 });
        return fuse.search(name).length > 0;
      })
      .map(async (_i, el) => new URL($(el).attr('href'), await this.getBaseUrl(ctx)))
      .get(0);
  }

  async extractSourceResults(ctx, $, el, countryCodes) {
    const localHtml = $(el).html();

    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/);
    const heightMatch = localHtml.match(/\d{3,}p/);

    const meta = {
      countryCodes: [...new Set([...countryCodes, ...findCountryCodes(localHtml)])],
      height: parseInt(heightMatch?.[0]),
      title: $('.file-title, .episode-file-title', el).text().trim(),
      ...(sizeMatch && { bytes: bytes.parse(sizeMatch[1]) }),
    };

    const urls = [];
    const seenUrls = new Set();

    $('a', el)
      .filter((_i, a) => {
        const href = $(a).attr('href');
        return !!href && HUB_HOST_PATTERN.test(href.toLowerCase());
      })
      .each((_i, a) => {
        const href = $(a).attr('href');
        try {
          const url = new URL(href);
          if (seenUrls.has(url.href)) return;
          seenUrls.add(url.href);

          if (DEAD_HUBCLOUD_HOSTS.has(url.hostname)) return;
          if (PIXEL_PATTERNS.test(url.href)) return;

          urls.push(url);
        } catch {
          // skip invalid URLs
        }
      });

    return Promise.all(urls.map(async url => ({
      url: await this.resolveIfRedirect(ctx, url),
      meta,
    })));
  }

  async resolveIfRedirect(ctx, url) {
    if (HUB_HOST_PATTERN.test(url.hostname)) {
      return url;
    }

    try {
      return await resolveRedirectUrl(ctx, this.fetcher, url);
    } catch {
      return url;
    }
  }

  async getBaseUrl(ctx) {
    return this.probeBaseUrl(ctx, this.fetcher, this.domainKey, this.FALLBACK_CANDIDATES);
  }
}
