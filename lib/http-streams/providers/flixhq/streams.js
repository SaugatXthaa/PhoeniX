/**
 * FlixHQ Provider (flixhq.app)
 *
 * Reverse-engineered flow:
 *   1. Search: GET /livesearch?q=<query> → HTML with <a href="/watch-movie/<slug>/">
 *      or <a href="/watch-series/<slug>/">.
 *   2. Movie page: GET /watch-movie/<slug>/
 *      Contains <div class="watch_block" data-token="<movie_token>">
 *   3. Movie servers: POST /ajax/ajax.php with FormData(players=<token>)
 *      Returns JSON [{ name, link, en_sub }]
 *   4. Series: GET /watch-series/<slug>/ → episode list <a href="/episode/<slug>/s01-e01/">
 *   5. Episode page: GET /episode/<slug>/s<SS>-e<EE>/
 *      Contains <div id="series-player" data-token="<episode_token>">
 *   6. Episode servers: POST /ajax/ajax.php with FormData(players_show=<token>)
 *      Returns JSON [{ name, link, en_sub }]
 *
 * Server links are embed pages (gn1r5n.org, vidmoly.biz, etc.) — return as externalUrl.
 *
 * Supports: movies, series, kdramas, anime (anything in their catalog).
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'FlixHQ';
const BASE_URL = (process.env.FLIXHQ_BASE_URL || 'https://flixhq.app').replace(/\/+$/, '');

const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const PAGE_CACHE_TTL = 10 * 60 * 1000;
const searchCache = new Map();
const pageCache = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

/**
 * Search FlixHQ via the /livesearch endpoint.
 * Returns array of { title, url, type, year }
 */
async function searchFlixHQ(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return cached.data;

    try {
        const url = `${BASE_URL}/livesearch?q=${encodeURIComponent(query)}`;
        const response = await makeRequest(url, {
            timeout: 10000,
            maxRetries: 0,
            headers: { ...REQUEST_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
            parseHTML: true
        });

        if (response.statusCode !== 200 || !response.document) {
            searchCache.set(cacheKey, { data: [], ts: Date.now() });
            return [];
        }

        const $ = response.document;
        const results = [];
        const seen = new Set();

        // Results: <a href="https://flixhq.app/watch-movie/<slug>/" class="nav-item">
        //   or <a href="https://flixhq.app/watch-series/<slug>/" class="nav-item">
        $('a.nav-item[href*="/watch-movie/"], a.nav-item[href*="/watch-series/"]').each((_, el) => {
            const $el = $(el);
            const href = $el.attr('href') || '';
            if (seen.has(href)) return;
            seen.add(href);

            const title = $el.find('.film-name').first().text().trim()
                || $el.find('h3').first().text().trim()
                || '';
            const inforText = $el.find('.film-infor').first().text().trim();
            const yearMatch = inforText.match(/(\d{4})/);
            const year = yearMatch ? yearMatch[1] : null;
            const type = href.includes('/watch-movie/') ? 'movie' : 'tv';

            if (title.length > 1) {
                results.push({ title, url: href, type, year });
            }
        });

        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        console.log(`[${PROVIDER}] Search "${query}" → ${results.length} results`);
        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search "${query}" failed: ${err.message}`);
        searchCache.set(cacheKey, { data: [], ts: Date.now() });
        return [];
    }
}

/**
 * Fetch a page and extract the data-token attribute.
 */
async function getPageToken(pageUrl, selector = '[data-token]') {
    const cached = pageCache.get(pageUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) return cached.token;

    try {
        const response = await makeRequest(pageUrl, {
            timeout: 12000,
            maxRetries: 0,
            headers: REQUEST_HEADERS,
            parseHTML: true
        });

        if (response.statusCode !== 200 || !response.document) {
            pageCache.set(pageUrl, { token: null, ts: Date.now() });
            return null;
        }

        const $ = response.document;
        const token = $(selector).first().attr('data-token') || null;
        pageCache.set(pageUrl, { token, ts: Date.now() });
        return token;
    } catch (err) {
        console.log(`[${PROVIDER}] getPageToken failed: ${err.message}`);
        pageCache.set(pageUrl, { token: null, ts: Date.now() });
        return null;
    }
}

/**
 * Fetch the episode list for a series.
 * Returns array of { season, episode, url }
 */
async function getEpisodeList(seriesUrl) {
    const cached = pageCache.get(`episodes:${seriesUrl}`);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) return cached.data;

    try {
        const response = await makeRequest(seriesUrl, {
            timeout: 12000,
            maxRetries: 0,
            headers: REQUEST_HEADERS,
            parseHTML: true
        });

        if (response.statusCode !== 200 || !response.document) {
            pageCache.set(`episodes:${seriesUrl}`, { data: [], ts: Date.now() });
            return [];
        }

        const $ = response.document;
        const episodes = [];
        const seen = new Set();

        // Episode links: /episode/<slug>/s01-e01/
        $('a[href*="/episode/"]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const match = href.match(/\/episode\/[^/]+\/s(\d+)-e(\d+)/i);
            if (!match) return;
            const season = parseInt(match[1], 10);
            const episode = parseInt(match[2], 10);
            const key = `${season}:${episode}`;
            if (seen.has(key)) return;
            seen.add(key);
            const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
            episodes.push({ season, episode, url: fullUrl });
        });

        pageCache.set(`episodes:${seriesUrl}`, { data: episodes, ts: Date.now() });
        console.log(`[${PROVIDER}] ${seriesUrl} → ${episodes.length} episodes`);
        return episodes;
    } catch (err) {
        console.log(`[${PROVIDER}] getEpisodeList failed: ${err.message}`);
        pageCache.set(`episodes:${seriesUrl}`, { data: [], ts: Date.now() });
        return [];
    }
}

/**
 * Call the FlixHQ AJAX API to get server list.
 * @param {string} token - The data-token from the page
 * @param {string} param - 'players' for movies, 'players_show' for episodes
 * @param {string} referer - The page URL (for Referer header)
 * @returns {Promise<Array<{name, link}>>}
 */
async function fetchServers(token, param, referer) {
    if (!token) return [];
    try {
        // Build multipart form data body
        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="${param}"\r\n\r\n${token}\r\n--${boundary}--\r\n`;

        const response = await makeRequest(`${BASE_URL}/ajax/ajax.php`, {
            method: 'POST',
            timeout: 12000,
            maxRetries: 0,
            headers: {
                ...REQUEST_HEADERS,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': referer,
                'Origin': BASE_URL
            },
            body
        });

        if (response.statusCode !== 200 || !response.body) {
            console.log(`[${PROVIDER}] AJAX API returned ${response.statusCode}`);
            return [];
        }

        const json = JSON.parse(response.body);
        if (Array.isArray(json)) return json;
        if (json && typeof json === 'object' && !json.error) return [json];
        if (json?.error) {
            console.log(`[${PROVIDER}] AJAX API error: ${json.error}`);
        }
        return [];
    } catch (err) {
        console.log(`[${PROVIDER}] fetchServers failed: ${err.message}`);
        return [];
    }
}

export async function getFlixHQStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) {
            console.log(`[${PROVIDER}] No metadata for ${imdbId}`);
            return [];
        }

        const expectedType = (type === 'series' || type === 'tv') ? 'tv' : 'movie';

        // Build search queries
        // Also try with colons removed (livesearch doesn't handle colons well)
        const cleanName = meta.name.replace(/[:]/g, '').replace(/\s+/g, ' ').trim();
        const cleanOriginal = meta.original_title ? meta.original_title.replace(/[:]/g, '').replace(/\s+/g, ' ').trim() : null;
        const queries = Array.from(new Set([
            meta.name,
            cleanName,
            removeYear(meta.name),
            removeYear(cleanName),
            ...(meta.original_title ? generateAlternativeQueries(meta.name, meta.original_title) : []),
            ...(cleanOriginal ? [cleanOriginal] : []),
            ...(meta.original_title ? [meta.original_title] : [])
        ].filter(Boolean).map(q => q.trim()).filter(q => q.length > 1)));

        // Search and find best match
        let bestMatch = null;
        for (const q of queries) {
            const results = await searchFlixHQ(q);
            if (results.length === 0) continue;
            // Filter by type first
            const typeMatches = results.filter(r => r.type === expectedType);
            const candidates = typeMatches.length ? typeMatches : results;
            const sorted = getSortedMatches(candidates, meta.name, { minScore: 40 });
            if (sorted.length > 0) {
                bestMatch = sorted[0];
                break;
            }
            if (!bestMatch) bestMatch = candidates[0];
        }

        if (!bestMatch) {
            console.log(`[${PROVIDER}] No match for "${meta.name}"`);
            return [];
        }

        console.log(`[${PROVIDER}] Matched: ${bestMatch.title} (${bestMatch.type}) → ${bestMatch.url}`);

        let servers = [];
        let episodeLabel = '';

        if (bestMatch.type === 'tv') {
            // Get episode list and find the requested episode
            const episodes = await getEpisodeList(bestMatch.url);
            if (episodes.length === 0) {
                console.log(`[${PROVIDER}] No episodes for ${bestMatch.title}`);
                return [];
            }

            const reqSeason = parseInt(season, 10) || 1;
            const reqEpisode = parseInt(episode, 10) || 1;
            const found = episodes.find(e => e.season === reqSeason && e.episode === reqEpisode)
                || episodes.find(e => e.season === reqSeason)
                || episodes[0];

            if (!found) {
                console.log(`[${PROVIDER}] Episode S${reqSeason}E${reqEpisode} not found`);
                return [];
            }

            episodeLabel = `S${found.season}E${found.episode}`;
            console.log(`[${PROVIDER}] Episode: ${episodeLabel}`);

            // Get episode token and fetch servers
            const token = await getPageToken(found.url, '#series-player[data-token], [data-token]');
            servers = await fetchServers(token, 'players_show', found.url);
        } else {
            // Movie — get token from watch-movie page
            const token = await getPageToken(bestMatch.url, '.watch_block[data-token], [data-token]');
            servers = await fetchServers(token, 'players', bestMatch.url);
        }

        if (servers.length === 0) {
            console.log(`[${PROVIDER}] No servers found`);
            return [];
        }

        // Build streams
        const streams = servers
            .filter(s => s.link && s.link.startsWith('http'))
            .map(s => ({
                name: `PhoeniX\nFlixHQ`,
                title: `${bestMatch.title}${episodeLabel ? ' ' + episodeLabel : ''}\n🔗 ${s.name} | ${PROVIDER}`,
                externalUrl: s.link,
                behaviorHints: {
                    bingeGroup: `phoenix-flixhq-${s.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
                    countryOfOrigin: meta.country || ''
                }
            }));

        console.log(`[${PROVIDER}] Returning ${streams.length} streams for ${meta.name}`);
        return streams;
    } catch (err) {
        console.log(`[${PROVIDER}] Error: ${err.message}`);
        return [];
    }
}
