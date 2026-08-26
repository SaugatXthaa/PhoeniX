/**
 * Source: 4KHDHub.store
 * Module ID: 4khdhub-store
 *
 * Mirror of 4KHDHub at the .store TLD. Same scraping pattern,
 * separate module so both can run in parallel for redundancy.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = '4KHDHub.store';
const BASE = 'https://4khdhub.store';

async function resolve(imdbId) {
  const parsed = utils.parseId(imdbId);
  if (!parsed) return [];

  const streams = [];
  try {
    const searchUrl = `${BASE}/?s=${encodeURIComponent(parsed.imdb)}`;
    const res = await http.get(searchUrl);
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

    const detailRes = await http.get(detailUrl);
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
