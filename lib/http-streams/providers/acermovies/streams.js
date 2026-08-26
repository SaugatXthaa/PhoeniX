/**
 * AcerMovies Provider (acermovies.fun)
 *
 * Reverse-engineered API flow:
 *   1. POST https://api2.acermovies.fun/api/search  {searchQuery: "..."}
 *      → {searchResult: [{title, url, image}]}
 *   2. POST https://api2.acermovies.fun/api/sourceQuality  {url: "..."}
 *      → {sourceQualityList: [{title, url, quality, episodesUrl, batchUrl}], meta: {...}}
 *   3. The quality URLs point to modpro.blog archives which contain HubCloud/hubdrive links
 *      → These go through the existing /resolve/httpstreaming/ resolver
 *
 * Supports: movies, series, anime, kdramas (anything in their catalog)
 */

import Cinemeta from '../../../util/cinemeta.js';
import { makeRequest } from '../../utils/http.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';

const PROVIDER = 'AcerMovies';
const API_BASE = (process.env.ACERMOVIES_API_URL || 'https://api2.acermovies.fun').replace(/\/+$/, '');
const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const QUALITY_CACHE_TTL = 10 * 60 * 1000;
const searchCache = new Map();
const qualityCache = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function postJson(path, body) {
    const response = await makeRequest(`${API_BASE}${path}`, {
        method: 'POST',
        timeout: 15000,
        maxRetries: 0,
        headers: {
            'User-Agent': UA,
            'Content-Type': 'application/json',
            'Origin': 'https://acermovies.fun',
            'Referer': 'https://acermovies.fun/'
        },
        body: JSON.stringify(body)
    });
    if (response.statusCode !== 200 || !response.body) return null;
    try { return JSON.parse(response.body); } catch { return null; }
}

async function searchAcerMovies(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return cached.data;

    const data = await postJson('/api/search', { searchQuery: query });
    const results = data?.searchResult || [];
    searchCache.set(cacheKey, { data: results, ts: Date.now() });
    console.log(`[${PROVIDER}] Search "${query}" → ${results.length} results`);
    return results;
}

async function getQualityLinks(url) {
    const cached = qualityCache.get(url);
    if (cached && Date.now() - cached.ts < QUALITY_CACHE_TTL) return cached.data;

    const data = await postJson('/api/sourceQuality', { url });
    const results = data?.sourceQualityList || [];
    qualityCache.set(url, { data: results, ts: Date.now() });
    return results;
}

export async function getAcerMoviesStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    // AcerMovies returns modpro.blog links which go through dead redirectors
    // (cloud.unblockedgames.world) that don't resolve to video URLs.
    // These links open an external browser which the user doesn't want.
    // Disabled until modpro.blog links are fixed or an alternative is found.
    return [];
}
