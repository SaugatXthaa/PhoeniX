// src/source/NineAnime.js
// 9anime.cl — anime streaming site (series + anime movies)
// Search: /?s={query} → anime page → episode links → episode page → base64 data-hash → embed URL

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class NineAnime extends Source {
  constructor(fetcher) {
    super();
    this.id = '9anime';
    this.label = '9Anime';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = 'https://9anime.cl';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const animePageUrl = await this.fetchAnimePageUrl(ctx, name, year, tmdbId);
    if (!animePageUrl) return [];

    const html = await this.fetcher.text(ctx, animePageUrl);
    const $ = cheerio.load(html);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // For movies (no season), get the first episode link
    // For series, find the matching episode
    let episodeUrl = null;

    if (tmdbId.season) {
      // Find episode link — 9anime uses /{slug}-episode-{N}/
      const epNum = tmdbId.episode || 1;
      const epLink = $(`.episodes-ul a`).filter((_i, el) => {
        const href = $(el).attr('href') || '';
        return href.includes(`episode-${epNum}`);
      }).first().attr('href');

      if (!epLink) return [];
      episodeUrl = new URL(epLink, this.baseUrl);
    } else {
      // Movie — get first episode link
      const firstEp = $(`.episodes-ul a`).last().attr('href');
      if (!firstEp) return [];
      episodeUrl = new URL(firstEp, this.baseUrl);
    }

    // Fetch episode page to extract server data-hash (base64 iframe)
    const epHtml = await this.fetcher.text(ctx, episodeUrl);
    const $ep = cheerio.load(epHtml);

    // Also check for direct iframe
    const directIframe = $ep('iframe').first().attr('src');
    if (directIframe) {
      return [{
        url: new URL(directIframe),
        meta: { countryCodes: [CountryCode.multi, CountryCode.ja], title },
      }];
    }

    // Try data-hash attributes (base64-encoded iframe HTML)
    const results = [];
    $ep('.server-item a[data-hash]').each((_i, el) => {
      const hash = $ep(el).attr('data-hash');
      if (!hash) return;
      try {
        const decoded = Buffer.from(hash, 'base64').toString('utf8');
        const iframeMatch = decoded.match(/src="([^"]+)"/);
        if (iframeMatch && iframeMatch[1]) {
          results.push({
            url: new URL(iframeMatch[1]),
            meta: { countryCodes: [CountryCode.multi, CountryCode.ja], title },
          });
        }
      } catch { /* skip invalid base64 */ }
    });

    return results;
  }

  async fetchAnimePageUrl(ctx, name, year, tmdbId) {
    // Try multiple search queries — normalize special characters (ū → u, etc.)
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), // remove diacritics
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(), // ascii only
      name.split(' ')[0], // first word only
    ].filter((q, i, arr) => q && arr.indexOf(q) === i); // dedupe

    for (const query of queries) {
      const searchUrl = new URL(`/?s=${encodeURIComponent(query)}`, this.baseUrl);
      let html;
      try {
        html = await this.fetcher.text(ctx, searchUrl);
      } catch { continue; }

      const $ = cheerio.load(html);

      // Find anime page link — /anime/{slug}/
      let bestMatch = null;
      const nameLower = name.toLowerCase();
      const nameAscii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

      $('a[href*="/anime/"]').each((_i, el) => {
        const href = $(el).attr('href');
        if (!href || href.includes('/anime/?') || href.includes('/az-list') || href.includes('/genres/')) return;
        const text = $(el).text().trim().toLowerCase();
        const hrefLower = href.toLowerCase();
        const yearStr = String(year);

        // For series: match by slug containing the title (without year)
        // and the year in the URL or nearby text
        const slug = nameAscii.replace(/\s+/g, '-');

        // Strong match: URL slug contains the title slug
        if (hrefLower.includes(slug) || hrefLower.includes(slug.replace(/shippuden/, 'shippuuden'))) {
          // For series, prefer URLs with the year
          if (tmdbId.season && hrefLower.includes(yearStr)) {
            bestMatch = href;
            return false; // break each loop
          }
          // For movies, take the first match
          if (!tmdbId.season && !bestMatch) {
            bestMatch = href;
          }
        }
      });

      if (bestMatch) return new URL(bestMatch, this.baseUrl);
    }

    return null;
  }
}
