'use strict';

/**
 * Stellar.rip source — standalone Node.js (CommonJS, ZERO npm dependencies).
 *
 * Resolves Stremio-style metadata (movie / series / anime / kdrama, by IMDb or
 * TMDB id) into Stellar embed URLs, and (via the sibling extractor file) into
 * direct playable streams — no playwright, no flaresolverr, no proxy env.
 *
 *   movie : https://stellar.rip/en/watch/embed/movie/{tmdbId}
 *   series: https://stellar.rip/en/watch/embed/tv/{tmdbId}-{season}-{episode}
 *
 * Works for movies, series, anime and kdramas — everything TMDB indexes.
 * Anime servers expose multi-audio playlists (subbed + dubbed tracks) and the
 * extractor surfaces the audio/sub labels plus resolutions up to 4K (2160p).
 *
 * Usage (library, one call -> playable streams):
 *   const { resolveStreams } = require('./stellar-source');
 *   const streams = await resolveStreams({ type: 'series', imdbId: 'tt9339044', season: 1, episode: 1 });
 *
 * Usage (library, embed URLs only):
 *   const { getEmbedUrls } = require('./stellar-source');
 *   const embeds = await getEmbedUrls({ type: 'movie', tmdbId: 1081003 });
 *
 * Usage (CLI):
 *   node stellar-source.js movie tt10865934
 *   node stellar-source.js series tt9339044 1 1
 *   node stellar-source.js --streams movie tmdb:1081003
 *
 * Environment:
 *   TMDB_API_KEY       v3 API key (falls back to the bundled public key)
 *   TMDB_ACCESS_TOKEN  v4 read access token (Bearer) — takes precedence
 *   STELLAR_SERVERS    optional comma-separated server ids (see extractor)
 */

const https = require('node:https');

const BASE_URL = 'https://stellar.rip';

/**
 * Bundled public TMDB v3 key (the same key widely shared by Stremio addons).
 * Override with the TMDB_API_KEY or TMDB_ACCESS_TOKEN env variable.
 */
const DEFAULT_TMDB_API_KEY = '8265bd1679663a7ea12ac168da84d2e8';

/* -------------------------------------------------------------------------- */
/*  Tiny HTTP layer                                                           */
/* -------------------------------------------------------------------------- */

const tmdbAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GETs a JSON document from TMDB (handles auth, redirects and brief throttles). */
async function tmdbGet(path, params = {}) {
  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY || DEFAULT_TMDB_API_KEY;

  if (!accessToken && !apiKey) {
    throw new Error('Either TMDB_ACCESS_TOKEN or TMDB_API_KEY env variable is required');
  }

  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, String(value));
    }
  }
  if (apiKey) {
    url.searchParams.set('api_key', apiKey);
  }

  const doRequest = () => new Promise((resolve, reject) => {
    const request = https.request({
      method: 'GET',
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
      },
      agent: tmdbAgent,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error(`TMDB request timed out: ${url.href}`)));
    request.on('error', reject);
    request.end();
  });

  /* TMDB answers 429 with Retry-After — retry a few times, then give up. */
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await doRequest();
    if (response.status >= 200 && response.status < 300) {
      try {
        return JSON.parse(response.body);
      } catch {
        throw new Error(`Invalid JSON from TMDB ${path}: ${response.body.slice(0, 200)}`);
      }
    }
    if (response.status === 429) {
      const retryAfter = 2;
      lastError = new Error(`TMDB throttled (429) for ${path}`);
      await sleep(retryAfter * 1000);
      continue;
    }
    throw new Error(`TMDB request failed (HTTP ${response.status}) for ${path}: ${response.body.slice(0, 200)}`);
  }
  throw lastError || new Error(`TMDB request failed for ${path}`);
}

/* -------------------------------------------------------------------------- */
/*  Metadata normalization                                                    */
/* -------------------------------------------------------------------------- */

/** Accepts 'movie'|'film' or 'series'|'tv'|'show' (case-insensitive). */
function normalizeType(type) {
  const value = String(type || '').toLowerCase();
  if (['movie', 'film', 'cinema'].includes(value)) return 'movie';
  if (['series', 'tv', 'show', 'anime', 'kdrama'].includes(value)) return 'tv';
  throw new Error(`Unsupported content type "${type}" (use movie or series)`);
}

/**
 * Normalizes flexible metadata input into { type, imdbId?, tmdbId?, season?, episode? }.
 *
 * Accepted shapes:
 *   { type: 'movie', imdbId: 'tt123', season?, episode? }
 *   { type: 'series', tmdbId: 123, season: 1, episode: 1 }
 *   { type: 'movie', id: 'tt123' }  /  { type: 'series', id: 'tt123:1:1' }
 *   { type: 'movie', id: 'tmdb:123' }
 *   'movie tt123'  /  'series tt123:1:1'  /  'movie tmdb:123'
 */
function normalizeMeta(input) {
  let meta = {};

  if (typeof input === 'string') {
    const parts = input.trim().split(/\s+/);
    if (parts.length >= 2) {
      meta.type = parts[0];
      meta.id = parts[1];
      if (parts[2]) meta.season = parseInt(parts[2], 10);
      if (parts[3]) meta.episode = parseInt(parts[3], 10);
    } else {
      meta.id = parts[0];
    }
  } else if (input && typeof input === 'object') {
    meta = { ...input };
  } else {
    throw new Error('Meta must be an object or string');
  }

  meta.type = normalizeType(meta.type);

  if (meta.id && !meta.imdbId && !meta.tmdbId) {
    const id = String(meta.id);
    if (/^tmdb:/i.test(id) || /^tmdb\d+$/i.test(id)) {
      meta.tmdbId = parseInt(id.replace(/^tmdb:?/i, ''), 10);
    } else if (/^tt\d+/i.test(id)) {
      let rest = id;
      if (rest.includes(':')) {
        const segments = rest.split(':');
        rest = segments[0];
        if (segments[1]) meta.season = parseInt(segments[1], 10);
        if (segments[2]) meta.episode = parseInt(segments[2], 10);
      }
      meta.imdbId = rest;
    } else if (/^\d+$/.test(id)) {
      meta.tmdbId = parseInt(id, 10);
    } else {
      throw new Error(`Unrecognized id "${id}" (expected tt... / tmdb:... / numeric TMDB id)`);
    }
  }

  if (meta.season !== undefined) meta.season = parseInt(meta.season, 10);
  if (meta.episode !== undefined) meta.episode = parseInt(meta.episode, 10);

  if (!meta.imdbId && !meta.tmdbId) {
    throw new Error('Either imdbId or tmdbId is required');
  }

  return meta;
}

/* -------------------------------------------------------------------------- */
/*  TMDB resolution (with in-memory caches)                                   */
/* -------------------------------------------------------------------------- */

const imdbTmdbCache = new Map();
const detailsCache = new Map();

/** Resolves {imdbId|tmdbId, type, season, episode} -> { id, type, season, episode }. */
async function getTmdbId(meta) {
  if (meta.tmdbId) {
    return { id: parseInt(meta.tmdbId, 10), type: meta.type, season: meta.season, episode: meta.episode };
  }

  const imdbId = String(meta.imdbId);
  const cacheKey = `${meta.type}:${imdbId}`;

  if (imdbTmdbCache.has(cacheKey)) {
    return { id: imdbTmdbCache.get(cacheKey), type: meta.type, season: meta.season, episode: meta.episode };
  }

  const response = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const primary = meta.type === 'tv' ? (response.tv_results || [])[0] : (response.movie_results || [])[0];
  const fallback = meta.type === 'tv' ? (response.movie_results || [])[0] : (response.tv_results || [])[0];
  const hit = primary || fallback;

  if (!hit || !hit.id) {
    throw new Error(`Could not get TMDB ID of IMDb ID "${imdbId}"`);
  }

  imdbTmdbCache.set(cacheKey, hit.id);
  return { id: hit.id, type: meta.type, season: meta.season, episode: meta.episode };
}

/** Resolves TMDB id -> [name, year] (title for movies, series name for tv). */
async function getTmdbNameAndYear(tmdb) {
  const cacheKey = `${tmdb.type}:${tmdb.id}`;

  if (detailsCache.has(cacheKey)) {
    return detailsCache.get(cacheKey);
  }

  let name;
  let year = null;

  if (tmdb.type === 'tv') {
    const details = await tmdbGet(`/tv/${tmdb.id}`);
    name = details.name || details.original_name;
    if (details.first_air_date) {
      const parsed = new Date(details.first_air_date);
      if (!isNaN(parsed.getTime())) year = parsed.getFullYear();
    }
  } else {
    const details = await tmdbGet(`/movie/${tmdb.id}`);
    name = details.title || details.original_title;
    if (details.release_date) {
      const parsed = new Date(details.release_date);
      if (!isNaN(parsed.getTime())) year = parsed.getFullYear();
    }
  }

  if (!name) {
    throw new Error(`Could not get name of TMDB ${tmdb.type} ${tmdb.id}`);
  }

  const value = [name, year];
  detailsCache.set(cacheKey, value);
  return value;
}

const pad2 = (n) => String(n).padStart(2, '0');

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolves metadata into Stellar embed URLs.
 *
 * @param {object|string} meta  see normalizeMeta()
 * @returns {Promise<Array<{url: string, title: string, mediaType: string, tmdbId: number, season?: number, episode?: number}>>}
 */
async function getEmbedUrls(metaInput) {
  const meta = normalizeMeta(metaInput);
  const tmdb = await getTmdbId(meta);

  if (tmdb.type === 'tv' && !(tmdb.season && tmdb.episode)) {
    throw new Error('Both season and episode are required for series');
  }

  const [name, year] = await getTmdbNameAndYear(tmdb);

  const url = tmdb.type === 'tv'
    ? `${BASE_URL}/en/watch/embed/tv/${tmdb.id}-${tmdb.season}-${tmdb.episode}`
    : `${BASE_URL}/en/watch/embed/movie/${tmdb.id}`;

  const title = tmdb.type === 'tv'
    ? `${name} S${pad2(tmdb.season)}E${pad2(tmdb.episode)}`
    : `${name}${year ? ` (${year})` : ''}`;

  return [{
    url,
    title,
    mediaType: tmdb.type,
    tmdbId: tmdb.id,
    ...(tmdb.type === 'tv' ? { season: tmdb.season, episode: tmdb.episode } : {}),
  }];
}

/**
 * One-call end-to-end resolution: metadata -> embed URL -> playable streams.
 * Requires stellar-extractor.js in the same directory.
 *
 * @param {object|string} meta     see normalizeMeta()
 * @param {object} [options]       forwarded to the extractor (servers, concurrency, verbose...)
 * @returns {Promise<Array<object>>} Stremio-ready stream objects (title prefixed with the episode/movie name)
 */
async function resolveStreams(metaInput, options = {}) {
  const embeds = await getEmbedUrls(metaInput);
  const extractor = require('./stellarrip-extractor.cjs');

  const all = [];
  for (const embed of embeds) {
    const streams = await extractor.extractStreams(embed.url, options);
    for (const stream of streams) {
      all.push({
        ...stream,
        title: `${embed.title}\n${stream.title}`,
        description: `${embed.title}\n${stream.title}`,
      });
    }
  }
  return all;
}

/** Frees the TMDB keep-alive sockets (CLI housekeeping). */
const destroy = () => tmdbAgent.destroy();

module.exports = {
  normalizeMeta,
  getTmdbId,
  getTmdbNameAndYear,
  getEmbedUrls,
  resolveStreams,
  destroy,
};

/* -------------------------------------------------------------------------- */
/*  CLI                                                                       */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--streams');
  const wantStreams = process.argv.includes('--streams');

  if (args.length < 2) {
    console.error('Usage:');
    console.error('  node stellar-source.js movie <imdbId | tmdb:N | N>');
    console.error('  node stellar-source.js series <imdbId | tmdb:N | N> <season> <episode>');
    console.error('  node stellar-source.js --streams series tt9339044 1 1   (embed -> playable streams)');
    process.exit(1);
  }

  const [type, id, season, episode] = args;
  const meta = { type, id, ...(season ? { season } : {}), ...(episode ? { episode } : {}) };

  (wantStreams ? resolveStreams(meta, { verbose: true }) : getEmbedUrls(meta))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      destroy();
      require('./stellarrip-extractor.cjs').destroy();
    })
    .catch((error) => {
      console.error(`ERROR: ${error.message}`);
      destroy();
      require('./stellarrip-extractor.cjs').destroy();
      process.exit(1);
    });
}
