/**
 * Source: ZXCStream (zxcstream.icu / zxcstream.xyz)
 *
 * Reverse-engineered from zxcstream.icu's Blogger-based frontend:
 *   - Main site: https://www.zxcstream.icu/
 *   - Embed player: https://zxcstream.xyz/embed/movie/{id}
 *   - Player page: https://zxcstream.xyz/player/movie/{id}?server=0
 *   - Also uses: mappletv.uk, vidsrc.xyz as alternative embed providers
 *
 * The site uses TMDB IDs for movie/series lookup.
 * Stream resolution flow:
 *   1. Convert IMDb ID -> TMDB ID (via TMDB find API)
 *   2. Build embed URL: https://zxcstream.xyz/embed/{type}/{tmdbId}
 *   3. Fetch the embed page (Next.js app)
 *   4. Extract direct .mp4/.m3u8 URLs from the page's JS data
 *
 * zxcstream.xyz is Cloudflare-protected - may return 403 from cloud IPs.
 * Uses browser-fingerprint headers to bypass.
 */

const axios = require('axios');
const utils = require('../utils');
const logger = require('../logger');
const cheerio = require('cheerio');

const SOURCE_TAG = 'ZXCStream';
const EMBED_BASE = 'https://zxcstream.xyz';
const SITE_ORIGIN = 'https://www.zxcstream.icu';

// Embed URL templates extracted from zxcstream.icu's source
const EMBED_TEMPLATES = {
  zxcstream_movie: (id) => `${EMBED_BASE}/embed/movie/${id}?autoPlay=true`,
  zxcstream_tv: (id, season, episode) =>
    `${EMBED_BASE}/embed/tv/${id}/${season}/${episode}?autoPlay=true`,
  zxcstream_player_movie: (id) =>
    `${EMBED_BASE}/player/movie/${id}?server=0&subLang=english`,
  zxcstream_player_tv: (id, season, episode) =>
    `${EMBED_BASE}/player/tv/${id}/${season}/${episode}?server=0&subLang=english`,
  mappletv_movie: (id) => `https://mappletv.uk/watch/movie/${id}`,
  mappletv_tv: (id, season, episode) =>
    `https://mappletv.uk/watch/tv/${id}-${season}-${episode}`,
  vidsrc_movie: (id) => `https://vidsrc.xyz/embed/movie/${id}`,
  vidsrc_tv: (id, season, episode) =>
    `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
};

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
 * Look up TMDB ID from IMDb ID.
 * Uses TMDB find API with no key (falls back to Cinemeta).
 * @returns {Promise<{tmdbId, title, year}|null>}
 */
async function lookupTmdbId(imdbId, type) {
  // Try TMDB with zstream.mov's embedded key first
  const TMDB_KEY = '84259f99204eeb7d45c7e3d8e36c6123';
  try {
    const endpoint = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
    const res = await Promise.race([
      axios.get(endpoint, { timeout: 5000, headers: { Accept: 'application/json' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB timeout')), 5000)),
    ]);
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const results = type === 'series' ? data.tv_results : data.movie_results;
    if (results && results.length) {
      const item = results[0];
      const yearStr = item.release_date || item.first_air_date || '';
      return {
        tmdbId: item.id,
        title: item.title || item.name || '',
        year: yearStr ? parseInt(yearStr.substring(0, 4), 10) : null,
      };
    }
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] TMDB lookup failed: ${err.message}`);
  }

  // Fallback: use Cinemeta to at least get the title
  try {
    const res = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 5000, headers: { Accept: 'application/json' } }
    );
    const meta = res.data?.meta;
    if (meta) {
      // Cinemeta doesn't provide TMDB ID directly, but we can try using the IMDb ID
      // with the embed providers (some support IMDb IDs)
      return { tmdbId: null, title: meta.name, year: null };
    }
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] Cinemeta fallback failed: ${err.message}`);
  }

  return null;
}

/**
 * Fetch an embed page and extract direct video URLs.
 * Uses browser-fingerprint headers to bypass Cloudflare.
 */
async function extractStreamsFromEmbed(embedUrl, referer) {
  try {
    const headers = utils.buildBrowserHeaders(
      embedUrl.match(/https?:\/\/([^/]+)/)?.[1] || 'zxcstream.xyz'
    );
    headers.Referer = referer || SITE_ORIGIN;

    const res = await axios.get(embedUrl, {
      timeout: 15000,
      headers,
      validateStatus: (s) => s < 500,
      maxRedirects: 5,
    });

    if (res.status !== 200) {
      logger.debug(`[${SOURCE_TAG}] embed ${embedUrl} returned ${res.status}`);
      return [];
    }

    const html = typeof res.data === 'string' ? res.data : String(res.data);

    // Look for direct video URLs
    const urlRegex = /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
    const directUrls = [...new Set(html.match(urlRegex) || [])];

    // Also look in __NEXT_DATA__ JSON (zxcstream.xyz is a Next.js app)
    const nextDataMatch = html.match(
      /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const jsonStr = JSON.stringify(data);
        const nextUrls = jsonStr.match(urlRegex) || [];
        directUrls.push(...nextUrls);
      } catch (_) {}
    }

    // Look in script tags
    const $ = cheerio.load(html);
    $('script').each((i, el) => {
      const content = $(el).html();
      if (content) {
        const matches = content.match(urlRegex) || [];
        directUrls.push(...matches);
      }
    });

    return [...new Set(directUrls)].filter((u) => utils.isVideoStreamUrl(u));
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] embed extraction failed for ${embedUrl}: ${err.message}`);
    return [];
  }
}

async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];

  const streams = [];

  try {
    // Step 1: Look up TMDB ID
    const tmdbMeta = await lookupTmdbId(ctx.imdb, ctx.type);
    if (!tmdbMeta) {
      logger.info(`[${SOURCE_TAG}] no metadata for ${ctx.imdb}`);
      return [];
    }

    // Use TMDB ID if available, otherwise fall back to IMDb ID
    const contentId = tmdbMeta.tmdbId || ctx.imdb;
    const title = tmdbMeta.title || ctx.imdb;

    logger.info(`[${SOURCE_TAG}] ${ctx.imdb} -> ID ${contentId} "${title}"`);

    // Step 2: Try multiple embed providers
    const embedUrls = [];

    if (ctx.type === 'series' && ctx.season && ctx.episode) {
      embedUrls.push({
        name: 'ZXCStream',
        url: EMBED_TEMPLATES.zxcstream_tv(contentId, ctx.season, ctx.episode),
      });
      embedUrls.push({
        name: 'ZXCStream Player',
        url: EMBED_TEMPLATES.zxcstream_player_tv(contentId, ctx.season, ctx.episode),
      });
      embedUrls.push({
        name: 'MappleTV',
        url: EMBED_TEMPLATES.mappletv_tv(contentId, ctx.season, ctx.episode),
      });
      embedUrls.push({
        name: 'VidSrc',
        url: EMBED_TEMPLATES.vidsrc_tv(contentId, ctx.season, ctx.episode),
      });
    } else {
      embedUrls.push({
        name: 'ZXCStream',
        url: EMBED_TEMPLATES.zxcstream_movie(contentId),
      });
      embedUrls.push({
        name: 'ZXCStream Player',
        url: EMBED_TEMPLATES.zxcstream_player_movie(contentId),
      });
      embedUrls.push({
        name: 'MappleTV',
        url: EMBED_TEMPLATES.mappletv_movie(contentId),
      });
      embedUrls.push({
        name: 'VidSrc',
        url: EMBED_TEMPLATES.vidsrc_movie(contentId),
      });
    }

    // Step 3: Extract direct video URLs from each embed
    for (const embed of embedUrls) {
      const directUrls = await extractStreamsFromEmbed(embed.url, SITE_ORIGIN);

      for (const url of directUrls.slice(0, 3)) {
        const s = utils.buildStream({
          sourceTag: `${SOURCE_TAG}`,
          title: `${SOURCE_TAG} • ${title}${
            ctx.season ? ` S${String(ctx.season).padStart(2, '0')}` : ''
          }${ctx.episode ? `E${String(ctx.episode).padStart(2, '0')}` : ''} • ${utils.detectQuality(url)} • ${utils.detectContainer(url)}`,
          url,
        });
        if (s) streams.push(s);
      }

      if (streams.length > 0) break; // Stop if we found streams
    }

    if (streams.length === 0) {
      logger.info(`[${SOURCE_TAG}] found embeds but no direct video URLs for ${ctx.imdb}`);
    }
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${ctx.imdb} -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
