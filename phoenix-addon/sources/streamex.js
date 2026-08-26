/**
 * Source: Streamex.sh
 * Module ID: streamex
 *
 * Resolves direct stream URLs from the Streamex.sh platform.
 * Looks up content by IMDb id and scrapes candidate links from
 * the returned page. Only HTTP(S) direct links are returned.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'Streamex';
const BASE = 'https://streamex.sh';

async function resolve(imdbId) {
  const parsed = utils.parseId(imdbId);
  if (!parsed) return [];

  const streams = [];
  try {
    const searchUrl = `${BASE}/search?q=${parsed.imdb}`;
    const res = await http.get(searchUrl);
    const html = res.data || '';

    // Try to find a detail page link.
    const detailMatch = html.match(
      /href="(\/(?:movie|series|title)\/[^"#?]+)"/i
    );
    if (!detailMatch) return [];

    const detailUrl = `${BASE}${detailMatch[1]}`;
    const detailRes = await http.get(detailUrl);
    const detailHtml = detailRes.data || '';

    // For series, attempt to drill into season/episode.
    let finalHtml = detailHtml;
    if (parsed.isSeries && parsed.season && parsed.episode) {
      const epMatch = detailHtml.match(
        new RegExp(
          `href="(/[^"]*s0?${parsed.season}e0?${parsed.episode}[^"]*)"`,
          'i'
        )
      );
      if (epMatch) {
        const epRes = await http.get(`${BASE}${epMatch[1]}`);
        finalHtml = epRes.data || '';
      }
    }

    // Pull candidate direct video URLs from the page.
    const urlRegex =
      /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm|m4v)(?:\?[^\s"'<>()]*)?/gi;
    const candidates = finalHtml.match(urlRegex) || [];
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
