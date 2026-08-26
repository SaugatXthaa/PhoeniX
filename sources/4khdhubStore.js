/**
 * Source: 4KHDHub.store
 * Module ID: 4khdhub-store
 *
 * Mirror of 4KHDHub at the .store TLD. Same scraping pattern,
 * separate module so both can run in parallel for redundancy.
 */

const http = require('../http');
const smartScraper = require('../smartScraper');

/** Wrapper that mimics http.get but uses smartScraper internally. */
const smartGet = async (url, opts = {}) => {
  const result = await smartScraper.smartFetch(url, opts);
  if (result && result.status === 200 && result.body) {
    return { status: 200, data: result.body };
  }
  return { status: 0, data: '' };
};
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = '4KHDHub.store';
const BASE = 'https://4khdhub.store';


/** Normalize input to a context object (supports both old string and new object API). */
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

async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];
  const imdbId = ctx.raw || ctx.imdb;
  const parsed = utils.parseId(imdbId);
  if (!parsed) return [];

  const streams = [];
  try {
    const searchUrl = `${BASE}/?s=${encodeURIComponent(parsed.imdb)}`;
    const res = await smartGet(searchUrl);
    const html = res.data || '';

    const detailMatch = html.match(
      /href="(https?:\/\/(?:www\.)?4khdhub\.store\/[^"#?]+)"/i
    );
    if (!detailMatch) return [];

    let detailUrl = detailMatch[1];

    if (parsed.isSeries && parsed.season && parsed.episode) {
      const epMatch = html.match(
        new RegExp(
          `href="(https?://[^"]*?(?:s0?${parsed.season}e0?${parsed.episode}|season-0?${parsed.season}-episode-0?${parsed.episode})[^"]*)"`,
          'i'
        )
      );
      if (epMatch) detailUrl = epMatch[1];
    }

    const detailRes = await smartGet(detailUrl);
    const detailHtml = detailRes.data || '';

    const urlRegex =
      /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm|m4v)(?:\?[^\s"'<>()]*)?/gi;
    const candidates = detailHtml.match(urlRegex) || [];
    const unique = [...new Set(candidates)];

    for (const url of unique.slice(0, 8)) {
      const s = utils.buildStream({
        sourceTag: SOURCE_TAG,
        title: `${SOURCE_TAG} • ${utils.detectQuality(url)} • ${utils.detectContainer(url)}`,
        url,
      });
      if (s) streams.push(s);
    }
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${imdbId} -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
