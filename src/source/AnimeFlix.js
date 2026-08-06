// src/source/AnimeFlix.js
// animeflix.team — anime streaming site (series + anime movies)
// Same WordPress structure as 9anime.cl:
// Search: /?s={query} → anime page → episode links → episode page → base64 data-hash → embed URL

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class AnimeFlix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animeflix';
    this.label = 'AnimeFlix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = 'https://animeflix.team';
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
      const epNum = tmdbId.episode || 1;
      const epLink = $(`.episodes-ul a`).filter((_i, el) => {
        const href = $(el).attr('href') || '';
        return href.includes(`episode-${epNum}`);
      }).first().attr('href');

      if (!epLink) return [];
      episodeUrl = new URL(epLink, this.baseUrl);
    } else {
      // Movie — get first episode link (last in list = episode 1)
      const firstEp = $(`.episodes-ul a`).last().attr('href');
      if (!firstEp) return [];
      episodeUrl = new URL(firstEp, this.baseUrl);
    }

    // Fetch episode page to extract server data-hash (base64 iframe HTML)
    const epHtml = await this.fetcher.text(ctx, episodeUrl);
    const $ep = cheerio.load(epHtml);

    // Check for direct iframe first
    const directIframe = $ep('iframe').first().attr('src');
    if (directIframe) {
      return [{
        url: new URL(directIframe),
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.ja],
          title,
          vidking: { name, year, tmdbId: tmdbId.id, ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }) },
        },
      }];
    }

    // Try data-hash attributes (base64-encoded iframe HTML)
    const results = [];
    const seenUrls = new Set();

    const vidkingMeta = { name, year, tmdbId: tmdbId.id, ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }) };

    $ep('.server-item a[data-hash]').each((_i, el) => {
      const hash = $ep(el).attr('data-hash');
      if (!hash) return;
      try {
        const decoded = Buffer.from(hash, 'base64').toString('utf8');
        const iframeMatch = decoded.match(/src="([^"]+)"/);
        if (iframeMatch && iframeMatch[1]) {
          const url = iframeMatch[1].replace(/&amp;/g, '&');
          if (seenUrls.has(url)) return;
          seenUrls.add(url);
          results.push({
            url: new URL(url),
            meta: { countryCodes: [CountryCode.multi, CountryCode.ja], title, vidking: vidkingMeta },
          });
        }
      } catch { /* skip invalid base64 */ }
    });

    return results;
  }

  async fetchAnimePageUrl(ctx, name, year, tmdbId) {
    // Try multiple search queries — normalize special characters
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      name.split(' ')[0],
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      const searchUrl = new URL(`/?s=${encodeURIComponent(query)}`, this.baseUrl);
      let html;
      try {
        html = await this.fetcher.text(ctx, searchUrl);
      } catch { continue; }

      const $ = cheerio.load(html);

      let bestMatch = null;
      const nameLower = name.toLowerCase();
      const nameAscii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const slug = nameAscii.replace(/\s+/g, '-');
      const yearStr = String(year);

      $('a[href*="/anime/"]').each((_i, el) => {
        const href = $(el).attr('href');
        if (!href || href.includes('/anime/?') || href.includes('/az-list') || href.includes('/genres/')) return;
        const hrefLower = href.toLowerCase();

        // Match by URL slug (handles ū→u double-u variants like "shippuuden")
        if (hrefLower.includes(slug) || hrefLower.includes(slug.replace(/shippuden/, 'shippuuden'))) {
          if (tmdbId.season && hrefLower.includes(yearStr)) {
            bestMatch = href;
            return false;
          }
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
