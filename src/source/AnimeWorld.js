// src/source/AnimeWorld.js
// watchanimeworld.top — anime with multi-language streams (Hindi, Tamil, Telugu, etc.)
//
// Flow:
//   1. Search: /?s={title} → find /series/{slug}/ or /movies/{slug}/
//   2. For series: episode URL /episode/{slug}-{season}x{episode}/
//   3. Episode page: find iframe to play.zephyrix.top/video/{hash}
//   4. FirePlayer API: POST /player/index.php?data={hash}&do=getVideo
//      → returns { videoSource: "https://play.zephyrix.top/cdn/hls/{hash}/master.m3u8?..." }
//   5. HLS URL requires Referer: https://play.zephyrix.top/ to play
//
// Supports sub + dub via multiple audio tracks in the HLS playlist.
//
// IMPORTANT: The site's search treats colons in titles as separators, so
// searching for "Demon Slayer: Kimetsu no Yaiba" only returns the movie
// (which contains the full subtitle in its title) — never the series.
// We try multiple query variants: full title, main title before colon,
// and title with colons replaced by spaces.

import * as cheerio from 'cheerio';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://watchanimeworld.top';
const PLAYER_BASE = 'https://play.zephyrix.top';
const REFERER = 'https://play.zephyrix.top/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Normalize for fuzzy matching
const normalize = (s) => (s || '').toLowerCase()
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// Build a list of search queries to try, in order:
//   1. Full TMDB title
//   2. Main title only (before first colon) — e.g. "Demon Slayer"
//   3. Title with colons replaced by spaces
const buildQueries = (title) => {
  const queries = [title];
  const colonIdx = title.indexOf(':');
  if (colonIdx > 0) {
    const main = title.substring(0, colonIdx).trim();
    if (main) queries.push(main);
    const joined = title.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    if (joined && joined !== title) queries.push(joined);
  }
  return [...new Set(queries.filter(Boolean))];
};

export class AnimeWorld extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animeworld';
    this.label = 'AnimeWorld';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.ta, CountryCode.te, CountryCode.en, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search for the anime (strict type filter — series for TV, movies for movies)
    const wantedType = tmdbId.season ? 'series' : 'movies';
    const animeUrl = await this.findAnime(ctx, name, wantedType);
    if (!animeUrl) return [];

    // Step 2: Find episode URL (series only — movies skip directly to stream extraction)
    let episodeUrl = animeUrl;
    if (tmdbId.season) {
      episodeUrl = await this.findEpisode(ctx, animeUrl, tmdbId);
      if (!episodeUrl) return [];
    }

    // Step 3: Fetch episode page → find play.zephyrix.top embed URL
    const playerHash = await this.findPlayerHash(ctx, episodeUrl);
    if (!playerHash) return [];

    // Step 4: Call FirePlayer API to get HLS URL
    const hlsUrl = await this.fetchVideoSource(ctx, playerHash);
    if (!hlsUrl) return [];

    let parsed;
    try { parsed = new URL(hlsUrl); } catch { return []; }
    if (!parsed) return [];

    const results = [{
      url: parsed,
      format: Format.hls,
      meta: {
        countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.ja],
        title: `${title} (Multi-Audio)`,
        sourceId: this.id,
        sourceLabel: this.label,
      },
      requestHeaders: { Referer: REFERER },
    }];

    return results;
  }

  // Fetch a page using got-scraping
  async fetchPage(url) {
    try {
      const { gotScraping } = await import('got-scraping');
      const res = await gotScraping.get(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        timeout: { request: 15000 },
        throwHttpErrors: false,
        followRedirect: true,
      });
      return res.statusCode === 200 ? res.body : null;
    } catch { return null; }
  }

  // Search for anime by name — tries multiple query variants and only
  // accepts results of the correct type (series for TV, movies for movies).
  async findAnime(ctx, name, wantedType) {
    const queries = buildQueries(name);
    const nameNorm = normalize(name);

    for (const query of queries) {
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
      const html = await this.fetchPage(searchUrl);
      if (!html) continue;

      const $ = cheerio.load(html);

      // Collect all results of the correct type with scoring
      const candidates = [];
      const seen = new Set();
      $('a[href]').each((_i, el) => {
        const href = $(el).attr('href') || '';
        // Match /series/{slug}/ or /movies/{slug}/
        const match = href.match(new RegExp(`${BASE_URL.replace(/\./g, '\\.')}/(series|movies)/([^/?#]+)/?`));
        if (!match) return;
        const type = match[1];
        const slug = match[2];
        if (type !== wantedType) return;
        if (slug === 'page' || seen.has(slug)) return;
        seen.add(slug);

        // The <a> tag itself is often empty (class="lnk-blk") — the title is
        // in the enclosing <article>'s <h1>/<h2>/<h3> or in the <img alt>.
        // Walk up to the nearest <article> and look for a heading.
        const $article = $(el).closest('article');
        let text = '';
        if ($article.length > 0) {
          text = $article.find('h1, h2, h3, h4, h5, h6').first().text().trim()
                || $article.find('img').first().attr('alt')?.replace(/^Image\s+/i, '').trim()
                || '';
        }
        // Fallback: the <a> tag's own text
        if (!text) text = $(el).text().trim();
        // Fallback: title attr
        if (!text) text = $(el).attr('title') || '';

        const textNorm = normalize(text);
        if (!textNorm || textNorm.length <= 3) return;

        let score = 0;
        if (textNorm === nameNorm) score = 100;
        else if (nameNorm.startsWith(textNorm) && textNorm.length >= 6) score = 92;
        else if (textNorm.includes(nameNorm)) score = 90;
        else if (nameNorm.includes(textNorm) && textNorm.length >= 6) score = 85;
        else {
          // Word-overlap scoring — count how many words match
          const nameWords = nameNorm.split(' ').filter(w => w.length > 2);
          const textWords = textNorm.split(' ').filter(w => w.length > 2);
          if (nameWords.length > 0 && textWords.length > 0) {
            const common = nameWords.filter(w => textWords.includes(w));
            const overlap = common.length / Math.max(nameWords.length, textWords.length);
            if (overlap >= 0.5) score = overlap * 80;
          }
        }

        if (score > 0) {
          candidates.push({ url: href, score, text: textNorm, slug });
        }
      });

      if (candidates.length === 0) {
        // No matches for this query — try next query variant
        continue;
      }

      // Sort by score descending — best match first
      candidates.sort((a, b) => b.score - a.score);

      // Accept the best match if score >= 40
      if (candidates[0].score >= 40) {
        return candidates[0].url;
      }
    }

    return null;
  }

  // Find episode URL from anime page
  async findEpisode(ctx, animeUrl, tmdbId) {
    const html = await this.fetchPage(animeUrl);
    if (!html) return null;

    const $ = cheerio.load(html);

    // Find episode links matching the requested season/episode
    if (tmdbId.season) {
      const reqS = tmdbId.season;
      const reqE = tmdbId.episode || 1;
      // Episode URL pattern: /episode/{slug}-{season}x{episode}/
      const epPattern = new RegExp(`${reqS}x${reqE}(/|$)`);
      let epUrl = null;
      $('a[href*="/episode/"]').each((_i, el) => {
        const href = $(el).attr('href') || '';
        if (epPattern.test(href) && !epUrl) epUrl = href;
      });

      // If not found, try the first episode link as fallback
      if (!epUrl) {
        $('a[href*="/episode/"]').each((_i, el) => {
          const href = $(el).attr('href') || '';
          if (!epUrl) epUrl = href;
        });
      }

      return epUrl;
    }

    // Movie — find first episode link
    let epUrl = null;
    $('a[href*="/episode/"]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      if (!epUrl) epUrl = href;
    });
    return epUrl;
  }

  // Find play.zephyrix.top hash from episode page
  async findPlayerHash(ctx, episodeUrl) {
    const html = await this.fetchPage(episodeUrl);
    if (!html) return null;

    const $ = cheerio.load(html);

    // Find iframe with play.zephyrix.top
    let hash = null;
    $('iframe[src*="zephyrix.top"]').each((_i, el) => {
      const src = $(el).attr('src') || '';
      const match = src.match(/\/video\/([a-zA-Z0-9]+)/);
      if (match && !hash) hash = match[1];
    });

    // Also check data-src attributes
    if (!hash) {
      $('[data-src*="zephyrix.top"]').each((_i, el) => {
        const dataSrc = $(el).attr('data-src') || '';
        const match = dataSrc.match(/\/video\/([a-zA-Z0-9]+)/);
        if (match && !hash) hash = match[1];
      });
    }

    return hash;
  }

  // Call FirePlayer API to get HLS URL
  async fetchVideoSource(ctx, hash) {
    try {
      const { gotScraping } = await import('got-scraping');
      const apiUrl = `${PLAYER_BASE}/player/index.php?data=${hash}&do=getVideo`;
      const res = await gotScraping.post(apiUrl, {
        body: `hash=${hash}&r=${BASE_URL}/`,
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${PLAYER_BASE}/video/${hash}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: { request: 15000 },
        throwHttpErrors: false,
      });

      if (res.statusCode !== 200) return null;
      const data = JSON.parse(res.body);
      return data?.videoSource || null;
    } catch { return null; }
  }
}
