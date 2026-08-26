/**
 * Source: Acer Movies (acermovies.fun)
 * API: https://api2.acermovies.fun  (reverse-engineered from inline JS)
 *
 * API flow:
 *   1. POST /api/search {searchQuery: "title"}
 *      -> {searchResult: [{title, image, url}, ...]}
 *   2. POST /api/sourceQuality {url: <moviesmod url>}
 *      -> {sourceQualityList: [{title, url, quality, episodesUrl, batchUrl}], meta}
 *   3. POST /api/sourceUrl {url: <archive url>, seriesType: "movie"|"series"|"batch"}
 *      -> {sourceUrl: "https://direct-stream.mp4"}
 *   4. (for series) POST /api/sourceEpisodes {url: <episodesUrl>}
 *      -> {episodesList: [{title, url, episode}], ...}
 *
 * The backend proxies requests to links.modpro.blog which is often
 * cloudflare-blocked from cloud IPs. We attempt the API and gracefully
 * fall back if the proxy returns empty.
 */

const axios = require('axios');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'Acer';
const API_BASE = 'https://api2.acermovies.fun';
const SITE_ORIGIN = 'https://acermovies.fun';

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

/** Build the standard API headers. */
function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    Origin: SITE_ORIGIN,
    Referer: `${SITE_ORIGIN}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };
}

/** POST helper with retry. */
async function apiPost(endpoint, body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(`${API_BASE}${endpoint}`, body, {
        headers: apiHeaders(),
        timeout: 15000,
      });
      return res.data;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Search Acer for a title.
 * Returns array of {title, image, url}.
 */
async function searchAcer(query) {
  if (!query) return [];
  try {
    const data = await apiPost('/api/search', { searchQuery: query });
    return data && Array.isArray(data.searchResult) ? data.searchResult : [];
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] search failed: ${err.message}`);
    return [];
  }
}

/**
 * Get quality options for a search result.
 * Returns array of {title, url, quality, episodesUrl, batchUrl}.
 */
async function getSourceQuality(sourceUrl) {
  if (!sourceUrl) return [];
  try {
    const data = await apiPost('/api/sourceQuality', { url: sourceUrl });
    return data && Array.isArray(data.sourceQualityList)
      ? data.sourceQualityList
      : [];
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] sourceQuality failed: ${err.message}`);
    return [];
  }
}

/**
 * Resolve the actual direct stream URL from an archive URL.
 * Returns the direct video URL or null.
 */
async function getSourceUrl(archiveUrl, seriesType = 'movie') {
  if (!archiveUrl) return null;
  try {
    const data = await apiPost('/api/sourceUrl', {
      url: archiveUrl,
      seriesType,
    });
    if (data && data.sourceUrl && utils.isPlayableUrl(data.sourceUrl)) {
      return data.sourceUrl;
    }
    return null;
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] sourceUrl failed: ${err.message}`);
    return null;
  }
}

/**
 * Get episodes for a series source.
 * Returns array of {title, url, episode}.
 */
async function getSourceEpisodes(episodesUrl) {
  if (!episodesUrl) return [];
  try {
    const data = await apiPost('/api/sourceEpisodes', {
      url: episodesUrl,
    });
    return data && Array.isArray(data.episodesList)
      ? data.episodesList
      : [];
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] sourceEpisodes failed: ${err.message}`);
    return [];
  }
}

/**
 * Resolve streams for a context.
 */
async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];

  // Need a title to search Acer
  if (!ctx.title) {
    logger.debug(`[${SOURCE_TAG}] no title for ${ctx.imdb} - skipping`);
    return [];
  }

  const streams = [];

  try {
    // Build search query: title + year for better matching
    const query = ctx.year ? `${ctx.title} ${ctx.year}` : ctx.title;
    const searchResults = await searchAcer(query);

    if (!searchResults.length) {
      logger.info(`[${SOURCE_TAG}] no results for "${query}"`);
      return [];
    }

    // Pick the best match - prefer ones whose title contains our title
    const titleLower = ctx.title.toLowerCase();
    const bestMatch =
      searchResults.find((r) =>
        (r.title || '').toLowerCase().includes(titleLower)
      ) || searchResults[0];

    logger.info(
      `[${SOURCE_TAG}] "${query}" -> ${searchResults.length} results, ` +
        `picked: ${bestMatch.title}`
    );

    // Get quality options for the best match
    const qualityList = await getSourceQuality(bestMatch.url);
    if (!qualityList.length) {
      logger.info(`[${SOURCE_TAG}] no quality options for ${bestMatch.url}`);
      return [];
    }

    // For series with episodes, fetch episode list
    if (ctx.type === 'series' && ctx.season && ctx.episode) {
      const withEpisodes = qualityList.filter((q) => q.episodesUrl);
      for (const q of withEpisodes.slice(0, 3)) {
        const episodes = await getSourceEpisodes(q.episodesUrl);
        // Find the matching episode
        const epMatch = episodes.find(
          (e) =>
            e.episode === ctx.episode ||
            (e.title || '').includes(`E${String(ctx.episode).padStart(2, '0')}`) ||
            (e.title || '').includes(`Episode ${ctx.episode}`)
        );
        if (epMatch) {
          const directUrl = await getSourceUrl(epMatch.url, 'series');
          if (directUrl) {
            const s = utils.buildStream({
              sourceTag: SOURCE_TAG,
              title: `${SOURCE_TAG} • ${ctx.title} S${String(ctx.season).padStart(2, '0')}E${String(ctx.episode).padStart(2, '0')} • ${q.quality} • ${utils.detectContainer(directUrl)}`,
              url: directUrl,
            });
            if (s) streams.push(s);
          }
        }
      }
    } else {
      // Movie - try each quality option
      for (const q of qualityList.slice(0, 4)) {
        if (q.episodesUrl || q.batchUrl) continue; // skip series-only entries
        const directUrl = await getSourceUrl(q.url, 'movie');
        if (directUrl) {
          const s = utils.buildStream({
            sourceTag: SOURCE_TAG,
            title: `${SOURCE_TAG} • ${ctx.title} (${ctx.year || ''}) • ${q.quality} • ${utils.detectContainer(directUrl)}`,
            url: directUrl,
          });
          if (s) streams.push(s);
        }
      }
    }
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${ctx.imdb} (${ctx.title}) -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
