/**
 * lib/meta.js — Metadata lookup chain
 * Resolves IMDb ID → TMDB ID → movie/series name + year + original title
 * Uses Cinemeta first (free, no auth), falls back to OMDB public API, then TMDB.
 */

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const HTTP_TIMEOUT = 8000;

// In-memory caches (process-lifetime)
const imdbToTmdbCache = new Map();
const tmdbToImdbCache = new Map();
const metaCache = new Map();

/**
 * Get TMDB numeric ID from IMDb "tt12345678" ID.
 * Tries Cinemeta first (free Stremio meta service), then TMDB find endpoint.
 */
async function getTmdbFromImdb(imdbId, type) {
  const key = `${imdbId}:${type}`;
  if (imdbToTmdbCache.has(key)) return imdbToTmdbCache.get(key);

  // 1) Cinemeta — returns {moviedb_id} in meta (note: field is moviedb_id, not tmdb_id)
  try {
    const cinemetaType = type === 'series' ? 'series' : 'movie';
    const url = `https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`;
    const r = await axios.get(url, { httpsAgent, timeout: HTTP_TIMEOUT, validateStatus: () => true });
    if (r.status === 200 && r.data?.meta?.imdb_id) {
      const tmdbId = r.data.meta.tmdb_id || r.data.meta.moviedb_id || null;
      const name = r.data.meta.name || r.data.meta.title;
      const year = r.data.meta.year ? parseInt(r.data.meta.year, 10) :
                   (r.data.meta.released ? new Date(r.data.meta.released).getFullYear() : null);
      const originalName = r.data.meta.original_name || null;
      imdbToTmdbCache.set(key, tmdbId);
      metaCache.set(`${type}:${imdbId}`, { name, year, originalName, tmdbId, type });
      return tmdbId;
    }
  } catch (e) { /* fall through */ }

  // 2) TMDB find endpoint (uses public demo key if no TMDB_ACCESS_TOKEN env)
  try {
    const token = process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_API_KEY;
    if (token) {
      const url = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`;
      const headers = /^\d+$/.test(token)
        ? {} // v3 API key as query param
        : { Authorization: `Bearer ${token}` };
      const params = /^\d+$/.test(token) ? { api_key: token } : {};
      const r = await axios.get(url, {
        httpsAgent, timeout: HTTP_TIMEOUT, headers, params, validateStatus: () => true
      });
      if (r.status === 200) {
        const arr = type === 'series' ? r.data.tv_results : r.data.movie_results;
        if (arr?.[0]?.id) {
          imdbToTmdbCache.set(key, arr[0].id);
          return arr[0].id;
        }
      }
    }
  } catch (e) { /* fall through */ }

  // 3) OMDB — only has IMDb, but gives title + year + type
  try {
    const omdbKey = process.env.OMDB_API_KEY || 'trilogy'; // public demo key
    const r = await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbKey}`, {
      httpsAgent, timeout: HTTP_TIMEOUT, validateStatus: () => true
    });
    if (r.status === 200 && r.data?.Response === 'True') {
      // OMDB doesn't have TMDB, but stores title/year
      const name = r.data.Title;
      const year = r.data.Year ? parseInt(String(r.data.Year).slice(0, 4), 10) : null;
      metaCache.set(`${type}:${imdbId}`, {
        name, year, originalName: name, tmdbId: null, type
      });
      return null;
    }
  } catch (e) { /* give up */ }

  imdbToTmdbCache.set(key, null);
  return null;
}

/**
 * Get full meta: {name, year, originalName, tmdbId}
 */
async function getMeta(imdbId, type) {
  const cacheKey = `${type}:${imdbId}`;
  if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);

  await getTmdbFromImdb(imdbId, type);
  if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);

  // Last-ditch: scrape IMDb page for title + year
  try {
    const r = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
      httpsAgent, timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      validateStatus: () => true
    });
    if (r.status === 200) {
      const titleMatch = r.data.match(/<title>(.+?)<\/title>/);
      const ogTitleMatch = r.data.match(/<meta property="og:title" content="(.+?)"/);
      const text = (ogTitleMatch?.[1] || titleMatch?.[1] || '').trim();
      // e.g. "Inception (2010) - IMDb"
      const m = text.match(/^(.+?)\s*\((\d{4})\)/);
      const name = m ? m[1].trim() : text.replace(/\s*-\s*IMDb\s*$/i, '').trim();
      const year = m ? parseInt(m[2], 10) : null;
      if (name) {
        const meta = { name, year, originalName: name, tmdbId: null, type };
        metaCache.set(cacheKey, meta);
        return meta;
      }
    }
  } catch (e) { /* give up */ }

  return null;
}

/**
 * Parse Stremio-style ID "tt12345678:1:2" → {id, season, episode}
 */
function parseStremioId(rawId) {
  const parts = String(rawId || '').split(':');
  const id = parts[0];
  const season = parts.length > 1 && parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts.length > 2 && parts[2] ? parseInt(parts[2], 10) : null;
  return { id, season, episode };
}

module.exports = { getTmdbFromImdb, getMeta, parseStremioId };
