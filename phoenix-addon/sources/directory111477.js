/**
 * Source: Directory 111477 (via pastebin)
 * URL: https://pastebin.com/hhX6Ntxw
 *
 * Pastebin-hosted directory of stream endpoints. The paste contents are
 * expected to be either:
 *   - a JSON document with source URLs, or
 *   - a newline-delimited list of API endpoints.
 *
 * We fetch the raw paste, parse, and query each endpoint with the IMDb id.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'Directory111477';
const PASTE_RAW = 'https://pastebin.com/raw/hhX6Ntxw';

let endpointCache = null;
let endpointCacheAt = 0;
const ENDPOINT_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function getEndpoints() {
  if (endpointCache && Date.now() - endpointCacheAt < ENDPOINT_TTL) {
    return endpointCache;
  }
  const res = await http.get(PASTE_RAW, {
    headers: { Accept: 'text/plain, application/json' },
  });
  const text = String(res.data || '').trim();

  let endpoints = [];
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      endpoints = json.map((x) => (typeof x === 'string' ? x : x.url)).filter(Boolean);
    } else if (json.endpoints) {
      endpoints = json.endpoints.map((x) => (typeof x === 'string' ? x : x.url)).filter(Boolean);
    } else if (json.url) {
      endpoints = [json.url];
    }
  } catch (_) {
    endpoints = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//.test(l));
  }

  endpointCache = endpoints;
  endpointCacheAt = Date.now();
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
      endpoints.slice(0, 15).map(async (ep) => {
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
                title: `${SOURCE_TAG} • ${utils.detectQuality(u)} • ${utils.detectContainer(u)}`,
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
