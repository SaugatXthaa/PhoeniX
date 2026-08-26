/**
 * Source: Streaming APIs (via rentry.co)
 * URL: https://rentry.co/onbksdgu
 *
 * A rentry.co paste that lists one or more streaming API endpoints.
 * Each endpoint is queried with the IMDb id; response is expected to be
 * JSON with a streams/sources array, but we gracefully fall back to
 * scraping raw URLs from the response body.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'StreamingAPIs';
const PASTE_RAW = 'https://rentry.co/onbksdgu/raw';

let endpointsCache = null;
let endpointsCacheAt = 0;
const ENDPOINTS_TTL = 6 * 60 * 60 * 1000;

async function getEndpoints() {
  if (endpointsCache && Date.now() - endpointsCacheAt < ENDPOINTS_TTL) {
    return endpointsCache;
  }
  const res = await http.get(PASTE_RAW, {
    headers: { Accept: 'text/plain, application/json' },
  });
  const text = String(res.data || '').trim();

  let endpoints = [];
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      endpoints = json
        .map((x) => (typeof x === 'string' ? x : x.url || x.endpoint))
        .filter(Boolean);
    } else if (json.endpoints) {
      endpoints = json.endpoints.map((x) =>
        typeof x === 'string' ? x : x.url || x.endpoint
      );
    } else if (json.url) {
      endpoints = [json.url];
    }
  } catch (_) {
    endpoints = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//.test(l));
  }

  endpointsCache = endpoints;
  endpointsCacheAt = Date.now();
  return endpoints;
}

async function resolve(imdbId) {
  const parsed = utils.parseId(imdbId);
  if (!parsed) return [];

  const streams = [];
  try {
    const endpoints = await getEndpoints();
    if (!endpoints.length) return [];

    await Promise.all(
      endpoints.slice(0, 12).map(async (ep) => {
        try {
          const url = ep
            .replace('{imdb}', parsed.imdb)
            .replace('{season}', parsed.season || '')
            .replace('{episode}', parsed.episode || '')
            .replace('{id}', parsed.raw);

          const r = await http.get(url, {
            headers: { Accept: 'application/json, text/html' },
          });
          const ct = (r.headers['content-type'] || '').toLowerCase();

          if (ct.includes('json')) {
            const data =
              typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            const items = Array.isArray(data)
              ? data
              : data.streams || data.sources || data.links || [];
            for (const c of items) {
              const u = typeof c === 'string' ? c : c.url || c.src || c.link;
              if (!u) continue;
              const s = utils.buildStream({
                sourceTag: SOURCE_TAG,
                title: `${SOURCE_TAG} • ${
                  (c && c.quality) || utils.detectQuality(u)
                } • ${utils.detectContainer(u)}`,
                url: u,
              });
              if (s) streams.push(s);
            }
          } else {
            const html = String(r.data || '');
            const urlRegex =
              /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm|m4v)(?:\?[^\s"'<>()]*)?/gi;
            const matches = html.match(urlRegex) || [];
            for (const u of matches.slice(0, 4)) {
              const s = utils.buildStream({
                sourceTag: SOURCE_TAG,
                title: `${SOURCE_TAG} • ${utils.detectQuality(u)} • ${utils.detectContainer(u)}`,
                url: u,
              });
              if (s) streams.push(s);
            }
          }
        } catch (err) {
          logger.debug(`[${SOURCE_TAG}] endpoint failed ${ep}: ${err.message}`);
        }
      })
    );
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${imdbId} -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
