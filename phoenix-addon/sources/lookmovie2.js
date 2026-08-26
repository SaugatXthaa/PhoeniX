/**
 * Source: lookmovie2.to
 * Module ID: lookmovie2
 *
 * Lookmovie2 streaming platform. Streams are usually HLS via
 * internal API endpoint; we attempt to extract the playlist URL.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'LookMovie2';
const BASE = 'https://lookmovie2.to';

async function resolve(imdbId) {
  const parsed = utils.parseId(imdbId);
  if (!parsed) return [];

  const streams = [];
  try {
    // LookMovie exposes /api/v1/shows or /api/v1/movies with imdb lookup
    const endpoint = parsed.isSeries ? 'shows' : 'movies';
    const apiUrl = `${BASE}/api/v1/${endpoint}/search/?q=${encodeURIComponent(parsed.imdb)}`;
    const apiRes = await http.get(apiUrl, {
      headers: { Accept: 'application/json' },
    });

    let data;
    try {
      data = typeof apiRes.data === 'string' ? JSON.parse(apiRes.data) : apiRes.data;
    } catch (_) {
      data = null;
    }

    const items = data && (data.result || data.results || data.data || []);
    if (items && items.length) {
      const first = items[0];
      const id = first.id || first.slug;
      if (id) {
        let manifestUrl;
        if (parsed.isSeries && parsed.season && parsed.episode) {
          manifestUrl = `${BASE}/api/v1/shows/episode/${id}/seasons/${parsed.season}/episodes/${parsed.episode}/manifest`;
        } else {
          manifestUrl = `${BASE}/api/v1/${endpoint}/${id}/manifest`;
        }
        const mRes = await http.get(manifestUrl, {
          headers: { Accept: 'application/json' },
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
              title: `${SOURCE_TAG} • ${c.quality || utils.detectQuality(url)}`,
              url,
            });
            if (s) streams.push(s);
          }
        }
      }
    }

    // Fallback: scrape HTML page for raw m3u8/mp4 URLs.
    if (streams.length === 0) {
      const searchUrl = `${BASE}/search/?q=${encodeURIComponent(parsed.imdb)}`;
      const res = await http.get(searchUrl);
      const html = res.data || '';
      const urlRegex =
        /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
      const unique = [...new Set(html.match(urlRegex) || [])];
      for (const url of unique.slice(0, 6)) {
        const s = utils.buildStream({
          sourceTag: SOURCE_TAG,
          title: `${SOURCE_TAG} • ${utils.detectQuality(url)}`,
          url,
        });
        if (s) streams.push(s);
      }
    }
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${imdbId} -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
