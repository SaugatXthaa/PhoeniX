// src/source/Fmovies.js
// thefmovies.sbs — movies and TV series with direct MP4 streams
//
// Flow:
//   1. Search: /?s={title} → find /movie/{slug}_{id}/ or /serie/{slug}_{id}/
//   2. Movie: fetch /movie/{slug}_{id}/?vod=1080p → parse <source> tags → direct MP4
//   3. TV: fetch /serie/{slug}_{id}/ → find episode link /serie/{slug}_{id}_{epNum}/
//      → fetch /serie/{slug}_{id}_{epNum}/?vod=1080p → parse <source> tags → direct MP4
//
// Stream URLs are direct MP4s on streamx.me or thefmovies.sbs/videos/ — no login
// required, supports Range requests, plays natively in Stremio.

import * as cheerio from 'cheerio';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://thefmovies.sbs';

export class Fmovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'fmovies';
    this.label = 'Fmovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    if (tmdbId.season) {
      // TV series — find the serie page, then the episode
      return this.handleSeries(ctx, name, year, tmdbId, title);
    }

    // Movie — find the movie page, then the VOD page
    return this.handleMovie(ctx, name, year, tmdbId, title);
  }

  async handleMovie(ctx, name, year, tmdbId, title) {
    const movieUrl = await this.findContentPage(ctx, name, '/movie/');
    if (!movieUrl) return [];

    // Fetch the VOD page which contains the <source> tags
    const vodUrl = new URL(`${movieUrl.pathname}?vod=1080p`, BASE_URL);
    let html;
    try {
      html = await this.fetcher.text(ctx, vodUrl);
    } catch { return []; }

    const $ = cheerio.load(html);
    const results = [];

    // Collect all source tags first
    const sourceEntries = [];
    $('video source[src]').each((_i, el) => {
      const src = $(el).attr('src');
      const label = $(el).attr('label') || '';
      if (!src) return;
      sourceEntries.push({ src, label });
    });

    // Check each stream URL's file size — thefmovies.sbs sometimes serves
    // tiny trailer/sample clips (under 50MB) instead of full movies. These
    // trigger Cloudflare ToS violation errors when played. Filter them out
    // so only real movies are returned.
    const MIN_MOVIE_SIZE = 50 * 1024 * 1024; // 50MB — real movies are 300MB+
    const seenUrls = new Set();

    for (const { src, label } of sourceEntries) {
      // Skip duplicate URLs (thefmovies often lists same URL for all qualities)
      if (seenUrls.has(src)) continue;
      seenUrls.add(src);

      try {
        const url = new URL(src);
        const height = parseInt(label.match(/(\d{3,4})p?/)?.[1] || '0') || undefined;

        // HEAD request to check file size
        let fileSize = 0;
        try {
          const res = await this.fetcher.fetch(ctx, url, {
            method: 'HEAD',
            timeout: 5000,
          });
          const cl = res.headers?.['content-length'] || res.headers?.['Content-Length'];
          if (cl) fileSize = parseInt(Array.isArray(cl) ? cl[0] : cl) || 0;
        } catch { /* skip — assume valid if HEAD fails */ }

        // Skip streams that are too small (trailers/samples)
        if (fileSize > 0 && fileSize < MIN_MOVIE_SIZE) continue;

        results.push({
          url,
          format: Format.mp4,
          meta: {
            countryCodes: [CountryCode.multi],
            ...(height && { height }),
            title: `${title} (${label || 'MP4'})`,
            sourceId: this.id,
            sourceLabel: this.label,
            ...(fileSize > 0 && { bytes: fileSize }),
          },
        });
      } catch { /* skip invalid URL */ }
    }

    return results;
  }

  async handleSeries(ctx, name, year, tmdbId, title) {
    const serieUrl = await this.findContentPage(ctx, name, '/serie/');
    if (!serieUrl) return [];

    // Fetch the serie page to find the season link
    let serieHtml;
    try {
      serieHtml = await this.fetcher.text(ctx, serieUrl);
    } catch { return []; }

    const targetSeason = tmdbId.season;
    const targetEpisode = tmdbId.episode || 1;

    // The serie page shows episodes for the LAST season by default.
    // Season links: /serie/{slug}_{id}_{season}/  (NOT an episode, a season page)
    // Episode links: /serie/{slug}_{id}_{s}_{ep}/  (specific episode)
    const $ = cheerio.load(serieHtml);

    // First, try to find the episode directly on the serie page (in case it
    // shows the target season's episodes)
    let episodePath = this.findEpisodeLink($, targetSeason, targetEpisode);
    if (episodePath) {
      return this.fetchEpisodeStreams(ctx, episodePath, title);
    }

    // Otherwise, find the season page link and fetch it
    const seasonPagePath = this.findSeasonLink($, targetSeason, serieUrl.pathname);
    if (!seasonPagePath) return [];

    const seasonPageUrl = new URL(seasonPagePath, BASE_URL);
    let seasonHtml;
    try {
      seasonHtml = await this.fetcher.text(ctx, seasonPageUrl);
    } catch { return []; }

    const $season = cheerio.load(seasonHtml);
    episodePath = this.findEpisodeLink($season, targetSeason, targetEpisode);
    if (!episodePath) return [];

    return this.fetchEpisodeStreams(ctx, episodePath, title);
  }

  // Find episode link matching _{season}_{episode}/
  findEpisodeLink($, targetSeason, targetEpisode) {
    let result = null;
    $('a[href*="/serie/"]').each((_i, el) => {
      if (result) return;
      const href = $(el).attr('href') || '';
      // Match /serie/{slug}_{id}_{season}_{episode}/
      // The slug can contain underscores, so match from the end: _{s}_{ep}/
      const m = href.match(/_(\d+)_(\d+)\/$/);
      if (m) {
        const linkSeason = parseInt(m[1]);
        const linkEpisode = parseInt(m[2]);
        if (linkSeason === targetSeason && linkEpisode === targetEpisode) {
          result = href;
        }
      }
    });
    return result;
  }

  // Find season page link: /serie/{slug}_{id}_{season}/
  // Must match EXACTLY the season page, not episode links like _5_1/
  findSeasonLink($, targetSeason, seriePathname) {
    const slugMatch = seriePathname.match(/\/serie\/([^/]+)\//);
    if (!slugMatch) return null;
    const slugId = slugMatch[1];

    // Season page ends with _{season}/ (single number, not _{s}_{ep}/)
    // Use regex to match exactly _{season}/ at the end, with no extra _N before it
    const seasonRegex = new RegExp(`_${targetSeason}/$`);
    let result = null;
    $('a[href*="/serie/"]').each((_i, el) => {
      if (result) return;
      const href = $(el).attr('href') || '';
      // Must contain the slugId and end with _{season}/
      // But NOT match _{s}_{season}/ (which is an episode link)
      if (href.includes(slugId) && seasonRegex.test(href)) {
        // Verify it's a season page, not an episode: the part after slugId
        // should be exactly _{season}/ not _{something}_{season}/
        const afterSlug = href.split(slugId)[1] || '';
        if (afterSlug === `_${targetSeason}/`) {
          result = href;
        }
      }
    });
    return result;
  }

  async fetchEpisodeStreams(ctx, episodePath, title) {
    const fullEpUrl = new URL(episodePath, BASE_URL);
    const vodUrl = new URL(`${fullEpUrl.pathname}?vod=1080p`, BASE_URL);
    let html;
    try {
      html = await this.fetcher.text(ctx, vodUrl);
    } catch { return []; }

    const $vod = cheerio.load(html);

    // Collect source entries and filter by size (same as handleMovie)
    const sourceEntries = [];
    $vod('video source[src]').each((_i, el) => {
      const src = $vod(el).attr('src');
      const label = $vod(el).attr('label') || '';
      if (!src) return;
      sourceEntries.push({ src, label });
    });

    const MIN_EPISODE_SIZE = 20 * 1024 * 1024; // 20MB — episodes are 100MB+
    const seenUrls = new Set();
    const results = [];

    for (const { src, label } of sourceEntries) {
      if (seenUrls.has(src)) continue;
      seenUrls.add(src);

      try {
        const url = new URL(src);
        const height = parseInt(label.match(/(\d{3,4})p?/)?.[1] || '0') || undefined;

        let fileSize = 0;
        try {
          const res = await this.fetcher.fetch(ctx, url, {
            method: 'HEAD',
            timeout: 5000,
          });
          const cl = res.headers?.['content-length'] || res.headers?.['Content-Length'];
          if (cl) fileSize = parseInt(Array.isArray(cl) ? cl[0] : cl) || 0;
        } catch { /* assume valid if HEAD fails */ }

        // Skip streams that are too small (trailers/samples)
        if (fileSize > 0 && fileSize < MIN_EPISODE_SIZE) continue;

        results.push({
          url,
          format: Format.mp4,
          meta: {
            countryCodes: [CountryCode.multi],
            ...(height && { height }),
            title: `${title} (${label || 'MP4'})`,
            sourceId: this.id,
            sourceLabel: this.label,
            ...(fileSize > 0 && { bytes: fileSize }),
          },
        });
      } catch { /* skip invalid URL */ }
    }

    return results;
  }

  async findContentPage(ctx, name, pathPrefix) {
    // Search for the title
    const searchUrl = new URL(`/?s=${encodeURIComponent(name)}`, BASE_URL);
    let html;
    try {
      html = await this.fetcher.text(ctx, searchUrl);
    } catch { return null; }

    const $ = cheerio.load(html);
    const nameLower = name.toLowerCase();

    // Find the first link matching the path prefix with a title that matches
    let bestMatch = null;
    $(`a[href*="${pathPrefix}"]`).each((_i, el) => {
      const href = $(el).attr('href');
      if (!href || href.includes('?s=')) return;

      // Get the title from the link text or alt attribute
      const linkText = $(el).text().trim().toLowerCase();
      const altText = ($(el).find('img').attr('alt') || '').toLowerCase();

      // Match by title containing the search name
      if (linkText.includes(nameLower) || altText.includes(nameLower) ||
          nameLower.includes(linkText.slice(0, 20))) {
        if (!bestMatch) bestMatch = href;
      }
    });

    // Fallback: just take the first matching path link
    if (!bestMatch) {
      bestMatch = $(`a[href*="${pathPrefix}"]`).first().attr('href');
    }

    if (!bestMatch) return null;

    // Ensure it's a full URL
    try {
      return bestMatch.startsWith('http') ? new URL(bestMatch) : new URL(bestMatch, BASE_URL);
    } catch { return null; }
  }
}
