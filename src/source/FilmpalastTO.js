// src/source/FilmpalastTO.js
// Ported from research/webstreamr-mbg/src/source/FilmpalastTO.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const STREAMING_HOSTS = [
  'voe', 'dood', 'streamtape', 'veev', 'vinovo', 'vidhide', 'dhtpre',
  'mixdrop', 'supervideo', 'uqload', 'filelion', 'lulustream', 'fastream',
  'dropload', 'savefiles', 'streamembed', 'vidara', 'vidsonic',
];

const isStreamingHost = (hostname) =>
  STREAMING_HOSTS.some(host => hostname.includes(host));

const resolveHref = (href, baseUrl) => {
  const fullHref = href.startsWith('//') ? `https:${href}` : href;
  return new URL(fullHref.startsWith('http') ? fullHref : `${baseUrl}${fullHref}`);
};

export class FilmpalastTO extends Source {
  constructor(fetcher) {
    super();
    this.id = 'filmpalast';
    this.label = 'Filmpalast';
    this.baseUrl = 'https://filmpalast.to';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.de];
    this.priority = 1;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, 'de');

    let streamPageUrl;
    try {
      streamPageUrl = await this.fetchStreamPageUrl(ctx, name, year, tmdbId.season, tmdbId.episode);
    } catch {
      return [];
    }
    if (!streamPageUrl) {
      return [];
    }

    const title = tmdbId.season
      ? `${name} ${TmdbId.formatSeasonAndEpisode(tmdbId)}`
      : `${name} (${year})`;

    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    const html = await this.fetcher.text(ctx, streamPageUrl);
    const $ = cheerio.load(html);

    const results = [];

    $('ul.currentStreamLinks').each((_i, streamBlock) => {
      const hostName = $(streamBlock).find('.hostName').text().trim();

      $(streamBlock).find('a[data-player-url]').each((_j, el) => {
        const playerUrl = $(el).attr('data-player-url');
        if (playerUrl?.startsWith('http')) {
          results.push({
            url: new URL(playerUrl),
            meta: {
              countryCodes: [CountryCode.de],
              referer: streamPageUrl.href,
              title: `${hostName} - ${title}`,
              sourceLabel: this.label,
              vidking: vidkingMeta,
            },
          });
        }
      });

      $(streamBlock).find('a[href]').each((_j, el) => {
        const href = $(el).attr('href');
        if (!href || href === '#' || href.startsWith('javascript') || href.includes('filmpalast.to') || $(el).attr('data-player-url')) {
          return;
        }

        try {
          const url = resolveHref(href, this.baseUrl);

          if (isStreamingHost(url.hostname)) {
            results.push({
              url,
              meta: {
                countryCodes: [CountryCode.de],
                referer: streamPageUrl.href,
                title: `${hostName} - ${title}`,
                sourceLabel: this.label,
                vidking: vidkingMeta,
              },
            });
          }
        } catch {
          // Invalid URL, skip
        }
      });
    });

    return results;
  }

  async fetchStreamPageUrl(ctx, name, year, season, episode) {
    const searchQuery = season
      ? `${name} S${String(season).padStart(2, '0')}E${String(episode ?? 1).padStart(2, '0')}`
      : name;

    const searchUrl = new URL(`/search/title/${encodeURIComponent(searchQuery)}`, this.baseUrl);
    const html = await this.fetcher.text(ctx, searchUrl);
    const $ = cheerio.load(html);

    const streamLinks = $('a[href*="/stream/"]')
      .map((_i, el) => ({
        href: $(el).attr('href'),
        title: ($(el).attr('title') ?? $(el).text().trim()),
      }))
      .get();

    if (streamLinks.length === 0) {
      return undefined;
    }

    // For movies: try to match by year first
    if (!season) {
      const yearMatch = streamLinks.find(link => link.title.includes(String(year)));
      if (yearMatch) {
        return resolveHref(yearMatch.href, this.baseUrl);
      }
    }

    // Fallback: use the first result
    const firstLink = streamLinks[0];
    if (!firstLink) {
      return undefined;
    }
    return resolveHref(firstLink.href, this.baseUrl);
  }
}
