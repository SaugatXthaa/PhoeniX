/**
 * Source: anitaku.io
 * Module ID: anitaku
 *
 * Anitaku anime streaming portal. Returns subbed/dubbed MP4/HLS links.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'Anitaku';
const BASE = 'https://anitaku.io';


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
    const searchUrl = `${BASE}/search.html?keyword=${encodeURIComponent(parsed.imdb)}`;
    const res = await http.get(searchUrl);
    const html = res.data || '';

    const detailMatch = html.match(
      /href="(\/[^"#?]*category\/[^"#?]+)"/i
    );
    if (!detailMatch) return [];

    const categoryUrl = `${BASE}${detailMatch[1]}`;
    const catRes = await http.get(categoryUrl);
    const catHtml = catRes.data || '';

    let targetUrl = categoryUrl;
    if (parsed.isSeries && parsed.season && parsed.episode) {
      // For anime, season/episode map: pick episode link.
      const epMatch = catHtml.match(
        new RegExp(
          `href="(\\/[^"]*?-episode-${parsed.episode}[^"]*)"`,
          'i'
        )
      );
      if (epMatch) targetUrl = `${BASE}${epMatch[1]}`;
    }

    const epRes = await http.get(targetUrl);
    const epHtml = epRes.data || '';

    const urlRegex =
      /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm|m4v)(?:\?[^\s"'<>()]*)?/gi;
    const candidates = epHtml.match(urlRegex) || [];
    const unique = [...new Set(candidates)];

    for (const url of unique.slice(0, 6)) {
      const s = utils.buildStream({
        sourceTag: SOURCE_TAG,
        title: `${SOURCE_TAG} • ${utils.detectQuality(url)} • ${utils.detectLanguage(url) || 'Sub'}`,
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
