// src/utils/tmdb.js

import { NotFoundError } from '../error/index.js';

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN || '';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const imdbTmdbMap = new Map();
const tmdbImdbMap = new Map();

const tmdbFetch = async (fetcher, ctx, path, searchParams = {}) => {
  const url = new URL(`${TMDB_BASE_URL}${path}`);

  // Use Bearer token if available, otherwise api_key
  const headers = {};
  if (TMDB_ACCESS_TOKEN) {
    headers['Authorization'] = `Bearer ${TMDB_ACCESS_TOKEN}`;
  } else if (TMDB_API_KEY) {
    url.searchParams.set('api_key', TMDB_API_KEY);
  } else {
    throw new NotFoundError('TMDB API key not configured');
  }

  for (const [k, v] of Object.entries(searchParams)) {
    if (v) url.searchParams.set(k, v);
  }

  return await fetcher.json(ctx, url, { headers });
};

export const getTmdbIdFromImdbId = async (fetcher, ctx, imdbId) => {
  if (imdbTmdbMap.has(imdbId.id)) {
    return { id: imdbTmdbMap.get(imdbId.id), season: imdbId.season, episode: imdbId.episode };
  }
  const response = await tmdbFetch(fetcher, ctx, `/find/${imdbId.id}`, { external_source: 'imdb_id' });
  const id = (imdbId.season ? response.tv_results?.[0] : response.movie_results?.[0])?.id;
  if (!id) throw new NotFoundError(`Could not get TMDB ID of IMDb ID "${imdbId.id}"`);
  imdbTmdbMap.set(imdbId.id, id);
  return { id, season: imdbId.season, episode: imdbId.episode };
};

export const getImdbIdFromTmdbId = async (fetcher, ctx, tmdbId) => {
  if (tmdbImdbMap.has(tmdbId.id)) {
    return { id: tmdbImdbMap.get(tmdbId.id), season: tmdbId.season, episode: tmdbId.episode };
  }
  const type = tmdbId.season ? 'tv' : 'movie';
  const response = await tmdbFetch(fetcher, ctx, `/${type}/${tmdbId.id}/external_ids`);
  tmdbImdbMap.set(tmdbId.id, response.imdb_id);
  return { id: response.imdb_id, season: tmdbId.season, episode: tmdbId.episode };
};

export const getTmdbNameAndYear = async (fetcher, ctx, tmdbId, language) => {
  const type = tmdbId.season ? 'tv' : 'movie';
  const details = await tmdbFetch(fetcher, ctx, `/${type}/${tmdbId.id}`, { language });
  if (tmdbId.season) {
    return [details.name, new Date(details.first_air_date).getFullYear(), details.original_name];
  }
  return [details.title, new Date(details.release_date).getFullYear(), details.original_title];
};
