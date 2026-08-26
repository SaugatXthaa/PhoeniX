/**
 * PhoeniX - TMDB Metadata Lookup
 * tmdb.js
 *
 * Converts IMDb IDs (tt1234567) into {title, year, type, poster, tmdbId}
 * so source modules can search by title (most sources don't support IMDb search).
 *
 * Primary: TMDB v3 API (requires TMDB_API_KEY env var)
 * Fallback 1: OMDB API (requires OMDB_API_KEY env var, free at omdbapi.com)
 * Fallback 2: Direct IMDb page scrape (no key needed, but fragile)
 *
 * Caches results for 24 hours to avoid hitting APIs rate limits.
 */

const http = require('./http');
const axios = require('axios');
const logger = require('./logger');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
// OMDB_API_KEY: set your own free key from https://www.omdbapi.com/apikey.aspx
// If unset, falls back to the public 'trilogy' test key (rate-limited but works).
const OMDB_API_KEY = process.env.OMDB_API_KEY || 'trilogy';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const OMDB_BASE = 'https://www.omdbapi.com';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// Track if TMDB is reachable - if it fails once, skip it for subsequent lookups
// (Render's network can't reach api.themoviedb.org, so we don't want to waste
// 5s on every request trying).
// Auto-detect: if PHOENIX_SKIP_TMDB=on, never try TMDB (useful for Render).
let TMDB_UNREACHABLE = process.env.PHOENIX_SKIP_TMDB === 'on';

// In-memory cache: imdbId -> metadata (24h TTL)
const TMDB_CACHE = new Map();
const TMDB_CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * Check if any metadata provider is configured.
 * Always returns true - OMDB has a public fallback key that works without config.
 */
function isConfigured() {
  return true;
}

/**
 * Look up metadata for an IMDb ID.
 * Tries OMDB first (most reliable from cloud hosts like Render),
 * then Cinemeta, then TMDB, then IMDb scrape.
 *
 * @param {string} imdbId - e.g. "tt0111161"
 * @param {string} type - "movie" | "series"
 * @returns {Promise<{imdb, title, year, type, tmdbId, poster, overview}|null>}
 */
async function lookupByImdb(imdbId, type = 'movie') {
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return null;

  // Cache check
  const cacheKey = `${imdbId}:${type}`;
  const cached = TMDB_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < TMDB_CACHE_TTL) {
    return cached.data;
  }

  // Try OMDB first - it uses omdbapi.com which is reliably reachable
  // from cloud hosts (including Render). Uses public 'trilogy' key fallback.
  // 2s hard timeout - if OMDB is unreachable, fail fast.
  if (OMDB_API_KEY) {
    try {
      const meta = await Promise.race([
        lookupViaOmdb(imdbId, type),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OMDB timeout')), 2000)
        ),
      ]);
      if (meta) {
        TMDB_CACHE.set(cacheKey, { ts: Date.now(), data: meta });
        logger.info(`[OMDB] ${imdbId} -> "${meta.title}" (${meta.year})`);
        return meta;
      }
    } catch (err) {
      logger.warn(`[OMDB] lookup failed for ${imdbId}: ${err.message}`);
    }
  }

  // Try Cinemeta (Stremio's free API, no key needed)
  // 2s hard timeout
  try {
    const meta = await Promise.race([
      lookupViaCinemeta(imdbId, type),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Cinemeta timeout')), 2000)
      ),
    ]);
    if (meta) {
      TMDB_CACHE.set(cacheKey, { ts: Date.now(), data: meta });
      logger.info(`[CINEMETA] ${imdbId} -> "${meta.title}" (${meta.year})`);
      return meta;
    }
  } catch (err) {
    logger.warn(`[CINEMETA] lookup failed for ${imdbId}: ${err.message}`);
  }

  // Skip TMDB on Render (known unreachable) - only try if key is set
  // and not already marked unreachable
  if (TMDB_API_KEY && !TMDB_UNREACHABLE) {
    try {
      const meta = await Promise.race([
        lookupViaTmdb(imdbId, type),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TMDB timeout')), 2000)
        ),
      ]);
      if (meta) {
        TMDB_CACHE.set(cacheKey, { ts: Date.now(), data: meta });
        logger.info(`[TMDB] ${imdbId} -> "${meta.title}" (${meta.year})`);
        return meta;
      }
    } catch (err) {
      logger.warn(`[TMDB] lookup failed for ${imdbId}: ${err.message}`);
      TMDB_UNREACHABLE = true;
    }
  }

  logger.info(`[Metadata] All lookups failed for ${imdbId}`);
  return null;
}

/**
 * Cinemeta lookup (Stremio's free metadata API, no key needed).
 * Endpoint: https://v3-cinemeta.strem.io/meta/{type}/{imdbId}.json
 */
async function lookupViaCinemeta(imdbId, type) {
  const endpoint = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;

  const res = await axios.get(endpoint, {
    headers: { Accept: 'application/json' },
    timeout: 5000,
    validateStatus: (s) => s < 500,
  });

  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (!data || !data.meta) return null;

  const meta = data.meta;
  const title = meta.name || '';
  const yearStr = meta.releaseInfo || '';
  const yearMatch = yearStr.match(/(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  return {
    imdb: imdbId,
    title,
    year,
    type: meta.type === 'series' ? 'series' : 'movie',
    tmdbId: null,
    poster: meta.poster || null,
    overview: meta.description || '',
    source: 'cinemeta',
  };
}

/**
 * TMDB lookup via the find endpoint.
 */
async function lookupViaTmdb(imdbId, type) {
  const endpoint = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;

  // Use a single attempt with a hard 5s timeout - don't retry on network
  // failures since TMDB is usually reliable; if it fails, fall through to OMDB.
  const res = await axios.get(endpoint, {
    headers: { Accept: 'application/json' },
    timeout: 5000,
    validateStatus: (s) => s < 500,
  });

  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (data && data.status_code && !data.success) {
    throw new Error(`TMDB error: ${data.status_message || 'Unknown'}`);
  }

  const results = type === 'series'
    ? (data.tv_results || [])
    : (data.movie_results || []);

  if (!results.length) return null;

  const item = results[0];
  const title = item.title || item.name || '';
  const yearStr = item.release_date || item.first_air_date || '';
  const year = yearStr ? parseInt(yearStr.substring(0, 4), 10) : null;

  return {
    imdb: imdbId,
    title,
    year,
    type,
    tmdbId: item.id,
    poster: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : null,
    overview: item.overview || '',
    source: 'tmdb',
  };
}

/**
 * OMDB API lookup (fallback).
 * Get a free key at https://www.omdbapi.com/apikey.aspx
 */
async function lookupViaOmdb(imdbId, type) {
  const endpoint = `${OMDB_BASE}/?i=${imdbId}&apikey=${OMDB_API_KEY}`;

  const res = await axios.get(endpoint, {
    headers: { Accept: 'application/json' },
    timeout: 3000,
    validateStatus: (s) => s < 500,
  });

  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (!data || data.Response === 'False') return null;

  const title = data.Title || '';
  const year = data.Year ? parseInt(data.Year.substring(0, 4), 10) : null;

  return {
    imdb: imdbId,
    title,
    year,
    type: data.Type === 'series' ? 'series' : 'movie',
    tmdbId: null,
    poster: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
    overview: data.Plot || '',
    source: 'omdb',
  };
}

/**
 * Fallback: scrape the title directly from IMDb's page.
 * No API key required, but depends on IMDb's HTML structure staying stable.
 */
async function lookupViaImdbScrape(imdbId) {
  const url = `https://www.imdb.com/title/${imdbId}/`;

  const res = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 8000,
    validateStatus: (s) => s < 500,
  });

  const html = typeof res.data === 'string' ? res.data : String(res.data);

  // IMDb uses JSON-LD structured data: <script type="application/ld+json">{...}</script>
  const jsonLdMatch = html.match(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (jsonLdMatch) {
    try {
      const json = JSON.parse(jsonLdMatch[1].trim());
      const title = json.name || '';
      const year = json.datePublished
        ? parseInt(String(json.datePublished).substring(0, 4), 10)
        : null;
      if (title) {
        return {
          imdb: imdbId,
          title,
          year,
          type: json['@type'] === 'TVSeries' ? 'series' : 'movie',
          tmdbId: null,
          poster: json.image || null,
          overview: json.description || '',
          source: 'imdb-scrape',
        };
      }
    } catch (_) {
      // JSON parse failed - fall through to regex
    }
  }

  // Fallback: regex extraction from <title> tag
  // Format: "The Dark Knight (2008) - IMDb"
  const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTagMatch) {
    const raw = titleTagMatch[1].trim();
    const titleMatch = raw.match(/^(.+?)\s*\((\d{4})\)/);
    if (titleMatch) {
      return {
        imdb: imdbId,
        title: titleMatch[1].trim(),
        year: parseInt(titleMatch[2], 10),
        type: 'movie',
        tmdbId: null,
        poster: null,
        overview: '',
        source: 'imdb-scrape',
      };
    }
  }

  return null;
}

/**
 * Search TMDB by title (fallback when IMDb lookup fails).
 */
async function searchByTitle(query, type = 'movie', year = null) {
  if (!TMDB_API_KEY || !query) return null;

  try {
    const endpoint = type === 'series'
      ? `${TMDB_BASE}/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}${year ? `&first_air_date_year=${year}` : ''}`
      : `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}${year ? `&year=${year}` : ''}`;

    const res = await axios.get(endpoint, {
      headers: { Accept: 'application/json' },
      timeout: 5000,
    });

    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const results = data.results || [];
    if (!results.length) return null;

    const item = results[0];
    const title = item.title || item.name || '';
    const yearStr = item.release_date || item.first_air_date || '';
    const yr = yearStr ? parseInt(yearStr.substring(0, 4), 10) : null;

    return {
      title,
      year: yr,
      type,
      tmdbId: item.id,
      poster: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : null,
      overview: item.overview || '',
      source: 'tmdb-search',
    };
  } catch (err) {
    logger.warn(`[TMDB] search failed for "${query}": ${err.message}`);
    return null;
  }
}

function buildSearchQuery(meta, sep = '+') {
  if (!meta || !meta.title) return '';
  let q = meta.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (meta.year) q += ` ${meta.year}`;
  return q.replace(/\s+/g, sep);
}

function slugifyTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = {
  isConfigured,
  lookupByImdb,
  searchByTitle,
  buildSearchQuery,
  slugifyTitle,
};
