/**
 * Source: acer (via pastebin)
 * URL: https://pastebin.com/Y8cEc0P0
 *
 * Generic paste-hosted source. The paste contains either a JSON config
 * describing the source's API endpoint, or a flat list of stream URLs
 * indexed by IMDb id.
 */

const http = require('../http');
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'Acer';
const PASTE_RAW = 'https://pastebin.com/raw/Y8cEc0P0';

let configCache = null;
let configCacheAt = 0;
const CONFIG_TTL = 6 * 60 * 60 * 1000;

async function getConfig() {
  if (configCache && Date.now() - configCacheAt < CONFIG_TTL) {
    return configCache;
  }
  const res = await http.get(PASTE_RAW, {
    headers: { Accept: 'text/plain, application/json' },
  });
  const text = String(res.data || '').trim();

  let config = { endpoints: [], urls: [] };
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      config.endpoints = json
        .map((x) => (typeof x === 'string' ? x : x.url))
        .filter(Boolean);
    } else if (json.endpoint) {
      config.endpoints = [json.endpoint];
    } else if (json.endpoints) {
      config.endpoints = json.endpoints;
    }
  } catch (_) {
    config.endpoints = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//.test(l));
  }

  configCache = config;
  configCacheAt = Date.now();
  return config;
}

async function resolve(imdbId) {
  const parsed = utils.parseId(imdbId);
  if (!parsed) return [];

  const streams = [];
  try {
    const config = await getConfig();
    if (!config.endpoints.length) return [];

    await Promise.all(
      config.endpoints.slice(0, 10).map(async (ep) => {
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
