// src/source/MovieBox.js
// Ported from research/webstreamr-mbg/src/source/MovieBox.ts

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

const SEARCH_PATH = '/wefeed-h5api-bff/subject/search';
const DOWNLOAD_PATH = '/wefeed-h5api-bff/subject/download';

const SUBJECT_TYPE_MOVIE = 1;
const SUBJECT_TYPE_TV = 2;

function stripSeasonSuffix(title) {
  return title.replace(/\s+S\d+$/, '');
}

export class MovieBox extends Source {
  constructor(fetcher) {
    super();
    this.id = 'moviebox';
    this.label = 'MovieBox';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://moviebox.ph';
    this.priority = -1;
    this.apiBaseUrl = 'https://h5-api.aoneroom.com';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const subjectType = tmdbId.season ? SUBJECT_TYPE_TV : SUBJECT_TYPE_MOVIE;

    const searchResult = await this.searchMovieBox(ctx, name, year, subjectType, tmdbId.season ?? 0);
    if (!searchResult) {
      return [];
    }

    const { subjectId, detailPath } = searchResult;

    const se = tmdbId.season ?? 0;
    const ep = tmdbId.episode ?? 0;

    const downloadUrl = new URL(`${this.apiBaseUrl}${DOWNLOAD_PATH}`);
    downloadUrl.searchParams.set('subjectId', subjectId);
    downloadUrl.searchParams.set('se', String(se));
    downloadUrl.searchParams.set('ep', String(ep));
    downloadUrl.searchParams.set('detailPath', detailPath);

    let title = name;
    if (tmdbId.season) {
      title += ` ${tmdbId.formatSeasonAndEpisode()}`;
    } else {
      title += ` (${year})`;
    }

    return [{
      url: downloadUrl,
      meta: {
        countryCodes: [CountryCode.multi],
        referer: 'https://videodownloader.site/',
        title,
      },
    }];
  }

  async searchMovieBox(ctx, name, year, subjectType, season) {
    const searchUrl = new URL(`${this.apiBaseUrl}${SEARCH_PATH}`);

    const payload = JSON.stringify({
      keyword: name,
      page: 1,
      perPage: 24,
      subjectType,
    });

    const responseText = await this.fetcher.textPost(
      ctx,
      searchUrl,
      payload,
      {
        headers: {
          ...this.getApiHeaders(),
          'Content-Type': 'application/json',
        },
      },
    );

    let response;
    try {
      response = JSON.parse(responseText);
    } catch {
      return null;
    }

    if (response.code !== 0 || !response.data?.items?.length) {
      return null;
    }

    const items = response.data.items;

    if (subjectType === SUBJECT_TYPE_MOVIE) {
      return this.matchMovie(items, name, year);
    }

    return this.matchTv(items, name, season);
  }

  matchMovie(items, name, year) {
    const yearStr = String(year);

    // Try exact match by title and year
    const exactMatch = items.find((item) => {
      const titleMatch = item.title?.toLowerCase() === name.toLowerCase();
      const yearMatch = !item.releaseDate || item.releaseDate.startsWith(yearStr);
      return titleMatch && yearMatch && item.hasResource;
    });

    if (exactMatch) {
      return { subjectId: exactMatch.subjectId, detailPath: exactMatch.detailPath };
    }

    // Fallback: first item with resources
    const firstWithResource = items.find(item => item.hasResource);
    if (firstWithResource) {
      return { subjectId: firstWithResource.subjectId, detailPath: firstWithResource.detailPath };
    }

    return null;
  }

  matchTv(items, name, season) {
    const matchingItems = items.filter((item) => {
      const baseTitle = stripSeasonSuffix(item.title);
      return baseTitle.toLowerCase() === name.toLowerCase();
    });

    if (matchingItems.length === 0) {
      const firstWithResource = items.find(item => item.hasResource);
      if (firstWithResource) {
        return { subjectId: firstWithResource.subjectId, detailPath: firstWithResource.detailPath };
      }
      return null;
    }

    const seasonMatch = matchingItems.find(item => item.season === season && item.hasResource);
    if (seasonMatch) {
      return { subjectId: seasonMatch.subjectId, detailPath: seasonMatch.detailPath };
    }

    const firstWithResource = matchingItems.find(item => item.hasResource);
    if (firstWithResource) {
      return { subjectId: firstWithResource.subjectId, detailPath: firstWithResource.detailPath };
    }

    return null;
  }

  getApiHeaders() {
    return {
      'Accept': 'application/json',
      'X-Client-Info': '{"timezone":"UTC"}',
      'Referer': 'https://videodownloader.site/',
    };
  }
}
