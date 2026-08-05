// src/utils/id.js

import { getTmdbIdFromImdbId, getImdbIdFromTmdbId } from './tmdb.js';

export const ImdbId = {
  fromString(id) {
    const parts = id.split(':');
    if (!parts[0] || !/^tt\d+$/.test(parts[0])) throw new Error(`IMDb ID "${id}" is invalid`);
    return { id: parts[0], season: parts[1] ? parseInt(parts[1]) : undefined, episode: parts[2] ? parseInt(parts[2]) : undefined };
  },
  formatSeasonAndEpisode(id) {
    return `S${String(id.season).padStart(2, '0')}E${String(id.episode).padStart(2, '0')}`;
  }
};

export const TmdbId = {
  fromString(id) {
    const parts = id.split(':');
    if (!parts[0] || !/^\d+$/.test(parts[0])) throw new Error(`TMDB ID "${id}" is invalid`);
    return { id: parseInt(parts[0]), season: parts[1] ? parseInt(parts[1]) : undefined, episode: parts[2] ? parseInt(parts[2]) : undefined };
  },
  formatSeasonAndEpisode(id) {
    return `S${String(id.season).padStart(2, '0')}E${String(id.episode).padStart(2, '0')}`;
  }
};

export const getImdbId = async (fetcher, ctx, id) => {
  if (typeof id.id === 'number') return getImdbIdFromTmdbId(fetcher, ctx, id);
  return id;
};

export const getTmdbId = async (fetcher, ctx, id) => {
  if (typeof id.id === 'string' && id.id.startsWith('tt')) return getTmdbIdFromImdbId(fetcher, ctx, id);
  return id;
};
