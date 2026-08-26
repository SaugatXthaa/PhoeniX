/**
 * Source: Ernax.pro
 * Module ID: ernax
 *
 * Ernax stream resolver. Often returns HLS playlists directly.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'Ernax';
const BASE = 'https://ernax.pro';

async function resolve(imdbId) {
  const parsed = utils.parseId(imdbId);
  if (!parsed) return [];

  const streams = [];
  try {
    // Try API-style endpoint first
    const apiUrl = `${BASE}/api/stream?imdb=${parsed.imdb}${
      parsed.season ? `&s=${parsed.season}` : ''
    }${parsed.episode ? `&e=${parsed.episode}` : ''}`;
    const res = await http.get(apiUrl, {
      headers: { Accept: 'application/json, text/html' },
    });
    const ct = (res.headers['content-type'] || '').toLowerCase();

    if (ct.includes('application/json')) {
      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      const candidates = Array.isArray(data)
        ? data
        : data.streams || data.links || data.sources || [];
      for (const c of candidates) {
        const url = typeof c === 'string' ? c : c.url || c.link || c.src;
        if (!url) continue;
        const s = utils.buildStream({
          sourceTag: SOURCE_TAG,
          title:
            typeof c === 'object' && (c.title || c.quality)
              ? `${SOURCE_TAG} • ${c.quality || utils.detectQuality(url)} • ${
                  c.title || ''
                }`
              : `${SOURCE_TAG} • ${utils.detectQuality(url)}`,
          url,
        });
        if (s) streams.push(s);
      }
    } else {
      const html = String(res.data || '');
      const urlRegex =
        /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm|m4v)(?:\?[^\s"'<>()]*)?/gi;
      const unique = [...new Set(html.match(urlRegex) || [])];
      for (const url of unique.slice(0, 8)) {
        const s = utils.buildStream({
          sourceTag: SOURCE_TAG,
          title: `${SOURCE_TAG} • ${utils.detectQuality(url)} • ${utils.detectContainer(url)}`,
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
