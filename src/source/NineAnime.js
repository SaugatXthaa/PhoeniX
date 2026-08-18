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
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.ja],
          title,
          // Don't pass vidking for anime — speedracelight returns wrong content
        },
      }];
    }

    // Try data-hash attributes (base64-encoded iframe HTML)
    const results = [];
    // Don't pass vidking for anime — speedracelight returns wrong content
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
    ].filter((q, i, arr) => q && arr.indexOf(q) === i); // dedupe

    for (const query of queries) {
      const searchUrl = new URL(`/?s=${encodeURIComponent(query)}`, this.baseUrl);
      let html;
      try {
        html = await this.fetcher.text(ctx, searchUrl);
      } catch { continue; }

      const $ = cheerio.load(html);

      // Find anime page link — /anime/{slug}/
      // Use scoring to avoid matching wrong anime (e.g. "Naruto" matching "Naruto Shippuden")
      let bestMatch = null;
      let bestScore = 0;
      const nameLower = name.toLowerCase().trim();
      const nameAscii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

      $('a[href*="/anime/"]').each((_i, el) => {
        const href = $(el).attr('href');
        if (!href || href.includes('/anime/?') || href.includes('/az-list') || href.includes('/genres/')) return;

        // The <a> tag's text is polluted with status/type labels like
        // "Movie Ongoing Demon Slayer: Kimetsu no Yaiba Infinity Castle".
        // Walk up to the nearest <article> and use its heading instead.
        const $article = $(el).closest('article');
        let text = '';
        if ($article.length > 0) {
          text = $article.find('h1, h2, h3, h4, h5, h6').first().text().trim();
        }
        // Fallback to <a> tag's own text (and strip whitespace)
        if (!text) text = $(el).text().trim();
        if (!text) return;
        const textLower = text.toLowerCase();

        let score = 0;
        if (textLower === nameLower) score = 100;
        else if (textLower === nameAscii) score = 95;
        else if (textLower.includes(nameLower) || nameLower.includes(textLower)) {
          // Use the longer of the two for the ratio — favours longer titles
          // (which are more specific matches). E.g. "Demon Slayer: Kimetsu no
          // Yaiba Hashira Training Arc (2024)" contains "Demon Slayer: Kimetsu
          // no Yaiba" — substring match.
          score = Math.min(textLower.length, nameLower.length) / Math.max(textLower.length, nameLower.length) * 90;
        }
        // Word-overlap fallback — handles TMDB titles that don't match any
        // site entry exactly (e.g. each Demon Slayer arc is a separate page
        // on the site, so "Demon Slayer: Kimetsu no Yaiba" S1 might match the
        // first arc's page rather than a page with the exact TMDB title).
        if (score < 50) {
          const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);
          const textWords = textLower.split(/\s+/).filter(w => w.length > 2);
          const common = nameWords.filter(w => textWords.includes(w));
          if (nameWords.length > 0 && common.length >= Math.min(nameWords.length, 2)) {
            const overlap = common.length / Math.max(nameWords.length, textWords.length);
            if (overlap >= 0.5) score = Math.max(score, overlap * 75);
          }
        }

        // Bonus for matching year (helps distinguish series from sequels)
        if (score > 0 && year) {
          const yearStr = String(year);
          if (href.includes(yearStr)) score += 5;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = href;
        }
      });

      // Lower threshold to 40 (from 60) — the site's per-arc pages often
      // have slightly different titles than TMDB (e.g. "Hashira Training
      // Arc" vs plain "Kimetsu no Yaiba"), so word-overlap scoring needs
      // a lower bar to find the right match.
      if (bestMatch && bestScore >= 40) return new URL(bestMatch, this.baseUrl);
    }

    return null;
  }
}
