/**
 * Source: aniworld.to
 * Module ID: aniworld
 *
 * German-language anime streaming portal. Hosts VoE/Streamtape/Vidoza
 * embeds; we attempt to extract direct MP4/HLS from the page.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'AniWorld';
const BASE = 'https://aniworld.to';


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
    const searchUrl = `${BASE}/anime/stream?query=${encodeURIComponent(parsed.imdb)}`;
    const res = await http.get(searchUrl);
    const html = res.data || '';

    const detailMatch = html.match(
      /href="(\/anime\/stream\/[^"#?]+)"/i
    );
    if (!detailMatch) return [];

    const seriesUrl = `${BASE}${detailMatch[1]}`;
    const seriesRes = await http.get(seriesUrl);
    const seriesHtml = seriesRes.data || '';

    let targetUrl = seriesUrl;
    if (parsed.isSeries && parsed.season && parsed.episode) {
      const epMatch = seriesHtml.match(
        new RegExp(
          `href="(\\/anime\\/stream\\/[^"]*?staffel-${parsed.season}\\/episode-${parsed.episode}[^"]*)"`,
          'i'
        )
      );
      if (epMatch) targetUrl = `${BASE}${epMatch[1]}`;
    }

    const epRes = await http.get(targetUrl);
    const epHtml = epRes.data || '';

    // AniWorld redirects to hosters via /redirect/link. Try to capture them.
    const redirectMatches =
      epHtml.match(
        /href="(https?:\/\/aniworld\.to\/redirect\/[^"]+)"/gi
      ) || [];

    const urlRegex =
      /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm|m4v)(?:\?[^\s"'<>()]*)?/gi;
    const direct = epHtml.match(urlRegex) || [];

    for (const r of redirectMatches) {
      const inner = r.match(/href="([^"]+)"/);
      if (inner) {
        try {
          const rRes = await http.get(inner[1]);
          const rHtml = rRes.data || '';
          const matches = rHtml.match(urlRegex) || [];
          direct.push(...matches);
        } catch (_e) {
          // skip
        }
      }
    }

    const unique = [...new Set(direct)];
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
