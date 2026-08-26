/**
 * Source: ZStream (zstream.mov)
 *
 * Reverse-engineered from zstream.mov's frontend JS:
 *   - TMDB API key embedded in JS: 84259f99204eeb7d45c7e3d8e36c6123
 *   - TMDB proxy: api.balloonerismm.workers.dev
 *   - Embed URL pattern: https://zstream.mov/movie/{tmdbId} or /tv/{tmdbId}
 *   - Player API: {backendURL}/api/player/status (backend is user-configurable)
 *
 * Since zstream.mov uses a client-side JS player with a configurable backend,
 * we extract direct stream URLs by:
 *   1. Looking up TMDB ID from IMDb ID (via TMDB find API)
 *   2. Fetching the embed page
 *   3. Extracting direct .mp4/.m3u8 URLs from the page's script tags
 *
 * Falls back to returning the embed URL itself if no direct streams found.
 */

const axios = require('axios');
const utils = require('../utils');
const logger = require('../logger');
const cheerio = require('cheerio');

const SOURCE_TAG = 'ZStream';
const BASE = 'https://zstream.mov';
const TMDB_API_KEY = '84259f99204eeb7d45c7e3d8e36c6123'; // embedded in zstream.mov's JS
const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Normalize input to a context object. */
function normalizeContext(input) {
  if (typeof input === 'string') {
    const parsed = utils.parseId(input);
    if (!parsed) return null;
    return {
      imdb: parsed.imdb,
      raw: input,
      title: null,
      year: null,
      type: parsed.isSeries ? 'series' : 'movie',
      season: parsed.season,
      episode: parsed.episode,
      isSeries: parsed.isSeries,
    };
  }
  return input;
}

/**
 * Look up TMDB ID from IMDb ID using zstream.mov's embedded TMDB key.
 * @returns {Promise<{tmdbId, title, year}|null>}
 */
async function lookupTmdbId(imdbId, type) {
  try {
    const endpoint = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const res = await Promise.race([
      axios.get(endpoint, { timeout: 5000, headers: { Accept: 'application/json' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB timeout')), 5000)),
    ]);
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const results = type === 'series' ? data.tv_results : data.movie_results;
    if (!results || !results.length) return null;
    const item = results[0];
    const yearStr = item.release_date || item.first_air_date || '';
    return {
      tmdbId: item.id,
      title: item.title || item.name || '',
      year: yearStr ? parseInt(yearStr.substring(0, 4), 10) : null,
    };
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] TMDB lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch the zstream.mov embed page and extract direct video URLs.
 * The page is a React SPA that loads video sources via JS.
 * We look for .mp4/.m3u8 URLs in the HTML and script tags.
 */
async function extractStreamsFromEmbed(embedUrl, ctx) {
  try {
    const res = await axios.get(embedUrl, {
      timeout: 15000,
      headers: utils.buildBrowserHeaders('zstream.mov'),
      validateStatus: (s) => s < 500,
    });
    const html = typeof res.data === 'string' ? res.data : String(res.data);

    // Look for direct video URLs in the HTML
    const urlRegex = /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
    const directUrls = [...new Set(html.match(urlRegex) || [])];

    // Also look for video source data in script tags
    const $ = cheerio.load(html);
    const scriptUrls = [];
    $('script').each((i, el) => {
      const content = $(el).html();
      if (content) {
        const matches = content.match(urlRegex) || [];
        scriptUrls.push(...matches);
      }
    });

    const allUrls = [...new Set([...directUrls, ...scriptUrls])];
    return allUrls.filter((u) => utils.isVideoStreamUrl(u));
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] embed extraction failed: ${err.message}`);
    return [];
  }
}

async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];

  const streams = [];

  try {
    // Step 1: Look up TMDB ID using zstream.mov's embedded API key
    const tmdbMeta = await lookupTmdbId(ctx.imdb, ctx.type);
    if (!tmdbMeta) {
      logger.info(`[${SOURCE_TAG}] no TMDB result for ${ctx.imdb}`);
      return [];
    }

    logger.info(
      `[${SOURCE_TAG}] ${ctx.imdb} -> TMDB ID ${tmdbMeta.tmdbId} "${tmdbMeta.title}"`
    );

    // Step 2: Build embed URL
    // zstream.mov uses TMDB IDs in its URLs
    const contentType = ctx.type === 'series' ? 'tv' : 'movie';
    const embedUrl = ctx.type === 'series' && ctx.season && ctx.episode
      ? `${BASE}/${contentType}/${tmdbMeta.tmdbId}/${ctx.season}/${ctx.episode}`
      : `${BASE}/${contentType}/${tmdbMeta.tmdbId}`;

    // Step 3: Try to extract direct video URLs from the embed page
    const directUrls = await extractStreamsFromEmbed(embedUrl, ctx);

    for (const url of directUrls.slice(0, 5)) {
      const s = utils.buildStream({
        sourceTag: SOURCE_TAG,
        title: `${SOURCE_TAG} • ${tmdbMeta.title || ctx.imdb}${
          ctx.season ? ` S${String(ctx.season).padStart(2, '0')}` : ''
        }${ctx.episode ? `E${String(ctx.episode).padStart(2, '0')}` : ''} • ${utils.detectQuality(url)} • ${utils.detectContainer(url)}`,
        url,
      });
      if (s) streams.push(s);
    }

    // Step 4: If no direct URLs found, return the embed URL as a browser-playable stream
    // Stremio will open it in the browser where zstream.mov's player loads
    if (streams.length === 0) {
      // Don't return non-video URLs as playable streams - Stremio rejects them.
      // Just log that we found the page but no direct streams.
      logger.info(`[${SOURCE_TAG}] found embed page but no direct video URLs: ${embedUrl}`);
    }
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${ctx.imdb} -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
