/**
 * Source: LookMovie2 (lookmovie2.to)
 *
 * Uses the LookMovie2 API to search by title, then extracts HLS streams.
 * Falls back to IMDb ID search if no title is available.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'LookMovie2';
const BASE = 'https://lookmovie2.to';

/**
 * Extract the context fields from either a string (old API) or object (new API).
 */
function normalizeContext(input) {
  if (typeof input === 'string') {
    const parsed = utils.parseId(input);
    return parsed ? { imdb: parsed.imdb, raw: input, title: null, year: null, type: parsed.isSeries ? 'series' : 'movie', season: parsed.season, episode: parsed.episode } : null;
  }
  return input;
}

async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];

  const streams = [];
  try {
    // LookMovie2 search API - supports title-based search
    const endpoint = ctx.type === 'series' ? 'shows' : 'movies';
    const query = ctx.title || ctx.imdb;
    if (!query) return [];

    const searchUrl = `${BASE}/api/v1/${endpoint}/search/?q=${encodeURIComponent(query)}`;
    const apiRes = await http.get(searchUrl, {
      headers: {
        Accept: 'application/json',
        Referer: `${BASE}/`,
        Origin: BASE,
      },
    });

    let data;
    try {
      data = typeof apiRes.data === 'string' ? JSON.parse(apiRes.data) : apiRes.data;
    } catch (_) {
      data = null;
    }

    const items = data && (data.result || data.results || data.data || []);
    if (items && items.length) {
      // Pick the best match - if we have a title, match by title; otherwise first
      const first = ctx.title
        ? items.find((it) => (it.title || it.name || '').toLowerCase().includes(ctx.title.toLowerCase())) || items[0]
        : items[0];

      const id = first.id || first.slug;
      if (id) {
        // Get the manifest/playlist
        let manifestUrl;
        if (ctx.type === 'series' && ctx.season && ctx.episode) {
          manifestUrl = `${BASE}/api/v1/shows/episode/${id}/seasons/${ctx.season}/episodes/${ctx.episode}/manifest`;
        } else {
          manifestUrl = `${BASE}/api/v1/${endpoint}/${id}/manifest`;
        }

        try {
          const mRes = await http.get(manifestUrl, {
            headers: { Accept: 'application/json', Referer: `${BASE}/` },
          });
          let m;
          try {
            m = typeof mRes.data === 'string' ? JSON.parse(mRes.data) : mRes.data;
          } catch (_) {
            m = null;
          }

          if (m) {
            const candidates = m.streams || m.sources || m.playlists || [];
            for (const c of candidates) {
              const url = typeof c === 'string' ? c : c.url || c.src || c.link;
              if (!url) continue;
              const s = utils.buildStream({
                sourceTag: SOURCE_TAG,
                title: `${SOURCE_TAG} • ${c.quality || utils.detectQuality(url)} • ${ctx.title || ctx.imdb}`,
                url,
              });
              if (s) streams.push(s);
            }
          }
        } catch (err) {
          logger.debug(`[${SOURCE_TAG}] manifest fetch failed: ${err.message}`);
        }
      }
    }

    // Fallback: scrape HTML for raw m3u8/mp4 URLs
    if (streams.length === 0) {
      const searchPageUrl = `${BASE}/search/?q=${encodeURIComponent(query)}`;
      const res = await http.get(searchPageUrl, {
        headers: { Referer: `${BASE}/` },
      });
      const html = String(res.data || '');
      const urlRegex =
        /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
      const unique = [...new Set(html.match(urlRegex) || [])];
      for (const url of unique.slice(0, 6)) {
        const s = utils.buildStream({
          sourceTag: SOURCE_TAG,
          title: `${SOURCE_TAG} • ${utils.detectQuality(url)} • ${ctx.title || ctx.imdb}`,
          url,
        });
        if (s) streams.push(s);
      }
    }
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${ctx.imdb} -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
