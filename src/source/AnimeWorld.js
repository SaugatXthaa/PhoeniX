// src/source/AnimeWorld.js
// watchanimeworld.top — anime with multi-language streams (Hindi, Tamil, Telugu, etc.)
//
// Flow:
//   1. Search: /?s={title} → find /anime/{slug}/
//   2. Anime page: find episode links /episode/{slug}-{season}x{episode}/
//   3. Episode page: find iframe to play.zephyrix.top/video/{hash}
//   4. FirePlayer API: POST /player/index.php?data={hash}&do=getVideo
//      → returns { videoSource: "https://play.zephyrix.top/cdn/hls/{hash}/master.m3u8?..." }
//   5. HLS URL requires Referer: https://play.zephyrix.top/ to play
//
// Supports sub + dub via multiple audio tracks in the HLS playlist.
// Also has Server 2 (ABYSS) with language-specific short.icu links — but
// short.icu is DNS-dead, so only Server 1 (zephyrix) is used.

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

    // Step 1: Search for the anime
    const animeUrl = await this.findAnime(ctx, name);
    if (!animeUrl) return [];

    // Step 2: Find episode URL
    const episodeUrl = await this.findEpisode(ctx, animeUrl, tmdbId, name);
    if (!episodeUrl) return [];

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

  // Search for anime by name
  async findAnime(ctx, name) {
    // First try direct URL (more reliable than search)
    // Normalize: replace special chars (ū→u, é→e, etc.) before slugifying
    const slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const directUrl = `${BASE_URL}/anime/${slug}/`;
    const testHtml = await this.fetchPage(directUrl);
    if (testHtml && testHtml.includes('episode')) return directUrl;

    // Fallback: search
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(name)}`;
    const html = await this.fetchPage(searchUrl);
    if (!html) return null;

    const $ = cheerio.load(html);
    const nameNorm = normalize(name);

    // Use scoring to avoid matching wrong anime (e.g. "Naruto" matching "Naruto Shippuden")
    let bestMatch = null;
    let bestScore = 0;
    $('a[href*="/anime/"]').each((_i, el) => {
      const href = $(el).attr('href');
      const text = normalize($(el).text());
      if (!href || text.length <= 3) return;

      let score = 0;
      if (text === nameNorm) score = 100;
      else if (text.includes(nameNorm) || nameNorm.includes(text)) {
        score = Math.min(text.length, nameNorm.length) / Math.max(text.length, nameNorm.length) * 90;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = href;
      }
    });

    // Only accept matches with score >= 60
    if (bestMatch && bestScore >= 60) return bestMatch;
    return null;
  }

  // Find episode URL from anime page
  async findEpisode(ctx, animeUrl, tmdbId, name) {
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
