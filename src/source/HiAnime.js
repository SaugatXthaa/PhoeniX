// src/source/HiAnime.js
// hianime.win — anime streaming site (series + anime movies)
// Search: /search?keyword={query} → watch page → episode list → episode page → server-item data-url

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class HiAnime extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hianime';
    this.label = 'HiAnime';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = 'https://hianime.win';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const watchUrl = await this.fetchWatchUrl(ctx, name);
    if (!watchUrl) return [];

    const html = await this.fetcher.text(ctx, watchUrl);
    const $ = cheerio.load(html);

    // Extract anime ID and slug from URL
    const match = watchUrl.pathname.match(/\/watch\/([^/]+)-(\d+)/);
    if (!match) return [];
    const slug = match[1];
    const animeId = match[2];

    // Get episode list
    const episodes = [];
    $('.ssl-item.ep-item').each((_i, el) => {
      const number = parseInt($(el).attr('data-number'));
      const epId = $(el).attr('data-id');
      const href = $(el).attr('href');
      if (number && epId && href) {
        episodes.push({ number, id: epId, url: new URL(href, this.baseUrl) });
      }
    });

    if (episodes.length === 0) return [];

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Find the requested episode
    let episode;
    if (tmdbId.season) {
      const epNum = tmdbId.episode || 1;
      episode = episodes.find(e => e.number === epNum) || episodes[0];
    } else {
      episode = episodes[0]; // Movie — first episode
    }

    if (!episode) return [];

    // Fetch episode page to get server URLs
    const epUrl = new URL(`/watch/${slug}-${animeId}/episode/${episode.number}`, this.baseUrl);
    const epHtml = await this.fetcher.text(ctx, epUrl);
    const $ep = cheerio.load(epHtml);

    const results = [];
    const seenUrls = new Set();

    const vidkingMeta = { name, year, tmdbId: tmdbId.id, ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }) };

    $ep('.item.server-item').each((_i, el) => {
      const type = $ep(el).attr('data-type') || 'sub';
      const url = $ep(el).attr('data-url');
      if (!url || !url.startsWith('http') || seenUrls.has(url)) return;
      seenUrls.add(url);

      const langLabel = type === 'dub' ? 'DUB' : 'SUB';
      results.push({
        url: new URL(url),
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.ja],
          title: `${title} (${langLabel})`,
          vidking: vidkingMeta,
        },
      });
    });

    return results;
  }

  async fetchWatchUrl(ctx, name) {
    // Try multiple search queries
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      name.split(' ')[0],
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      const searchUrl = new URL(`/search?keyword=${encodeURIComponent(query)}`, this.baseUrl);
      let html;
      try {
        html = await this.fetcher.text(ctx, searchUrl);
      } catch { continue; }

      const $ = cheerio.load(html);
      const nameLower = name.toLowerCase();
      const nameAscii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

      let bestMatch = null;
      $('.flw-item a[href*="/watch/"]').each((_i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const title = ($(el).attr('title') || $(el).attr('data-jname') || '').toLowerCase();
        if (title.includes(nameLower) || nameLower.includes(title) ||
            title.includes(nameAscii) || nameAscii.includes(title)) {
          if (!bestMatch) bestMatch = href;
        }
      });

      if (bestMatch) return new URL(bestMatch, this.baseUrl);
    }

    return null;
  }
}
