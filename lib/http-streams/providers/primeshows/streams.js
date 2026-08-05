/**
 * PrimeShows Provider (primeshows.gd)
 *
 * Reverse-engineered flow:
 *   1. Search: GET /api/search?q=<query> → JSON { results: [{ id, media_type, title, ... }] }
 *      The `id` is the TMDB ID (movie or tv).
 *   2. Watch page: GET /watch/movie/{tmdb_id}  or  /watch/tv/{tmdb_id}/season/{s}/episode/{e}
 *      The page contains <iframe id="playerFrame" src="..."> + multiple server buttons.
 *   3. Servers: append ?server=<name> to the watch URL to switch iframe src.
 *      Available servers (all return embed pages that Nuvio can play in a webview):
 *        vidsrcto   → vidsrc.mov/embed/{type}/{id}[/s/e]
 *        vidsrcfyi  → vidsrc.fyi/embed/{type}/{id}[/s/e]
 *        vidrock    → vidrock.net/{type}/{id}[/s/e]
 *        vidnest    → vidnest.fun/{type}/{id}[/s/e]
 *        vidking    → vidking.net/embed/{type}/{id}[/s/e]
 *        vidlink    → vidlink.pro/{type}/{id}?autoplay=true
 *        vidfast    → vidfast.pro/{type}/{id}?autoPlay=true
 *        vidup      → vidup.to/{type}/{id}?autoPlay=true
 *        videasy    → player.videasy.net/{type}/{id}
 *        111movies  → 111movies.com/{type}/{id}
 *        2embed     → 2embed.cc/embed/{id}
 *        multiembed → multiembed.mov/?video_id={id}&tmdb=1
 *        superflix  → superflixapi.co/filme/{id}
 *        peachify   → peachify.top/embed/{type}/{id}
 *
 * These are all embed pages that load video players via JS — they cannot be
 * resolved to direct CDN URLs server-side. We return them as externalUrl so
 * Nuvio opens them in a webview (same pattern as ZStream, VixSrc, etc.).
 *
 * Supports: movies, series, kdramas, anime (anything with a TMDB ID).
 * PrimeShows uses TMDB IDs natively, so we resolve IMDB → TMDB via Cinemeta.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { makeRequest } from '../../utils/http.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'PrimeShows';
const BASE_URL = (process.env.PRIMESHOWS_BASE_URL || 'https://primeshows.gd').replace(/\/+$/, '');

const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const WATCH_CACHE_TTL = 10 * 60 * 1000;
const searchCache = new Map();
const watchCache = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

// All available servers (in priority order — most reliable first)
const SERVERS = [
    { key: 'vidsrcto',   name: 'VidSrc.mov',  recommended: true },
    { key: 'vidsrcfyi',  name: 'VidSrc.fyi' },
    { key: 'vidnest',    name: 'Vidnest' },
    { key: 'vidlink',    name: 'VidLink' },
    { key: 'vidfast',    name: 'VidFast' },
    { key: '2embed',     name: '2Embed' },
    { key: 'vidrock',    name: 'VidRock' },
    { key: 'vidking',    name: 'VidKing' },
    { key: 'vidup',      name: 'VidUp' },
    { key: 'videasy',    name: 'Videasy' },
    { key: 'multiembed', name: 'MultiEmbed' },
    { key: 'superflix',  name: 'SuperFlix' },
    { key: 'peachify',   name: 'Peachify' },
    { key: '111movies',  name: '111Movies' }
];

/**
 * Extract TMDB ID from Cinemeta metadata.
 * Cinemeta returns moviedb_id for movies and moviedb_id for series.
 */
function resolveTmdbId(meta) {
    if (!meta) return null;
    // moviedb_id is the TMDB ID (Cinemeta field name)
    if (meta.moviedb_id) {
        const id = String(meta.moviedb_id);
        if (/^\d+$/.test(id)) return id;
    }
    // Some Cinemeta responses have tmdb_id
    if (meta.tmdb_id) {
        const id = String(meta.tmdb_id);
        if (/^\d+$/.test(id)) return id;
    }
    return null;
}

/**
 * Search PrimeShows for a query.
 * Returns array of { id, media_type, title, release_date }
 */
async function searchPrimeShows(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return cached.data;

    try {
        const url = `${BASE_URL}/api/search?q=${encodeURIComponent(query)}`;
        const response = await makeRequest(url, {
            timeout: 10000,
            maxRetries: 0,
            headers: { ...REQUEST_HEADERS, 'X-Requested-With': 'XMLHttpRequest' }
        });

        if (response.statusCode !== 200 || !response.body) {
            searchCache.set(cacheKey, { data: [], ts: Date.now() });
            return [];
        }

        const json = JSON.parse(response.body);
        const results = Array.isArray(json?.results) ? json.results : [];
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
 * Get the iframe embed URL for a specific server by fetching the watch page.
 */
async function getEmbedUrl(tmdbId, mediaType, season, episode, serverKey) {
    const cacheKey = `${tmdbId}:${mediaType}:${season || 0}:${episode || 0}:${serverKey}`;
    const cached = watchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < WATCH_CACHE_TTL) return cached.url;

    const watchPath = mediaType === 'tv'
        ? `/watch/tv/${tmdbId}/season/${season || 1}/episode/${episode || 1}`
        : `/watch/movie/${tmdbId}`;
    const watchUrl = `${BASE_URL}${watchPath}?server=${serverKey}`;

    try {
        const response = await makeRequest(watchUrl, {
            timeout: 10000,
            maxRetries: 0,
            headers: REQUEST_HEADERS
        });

        if (response.statusCode !== 200 || !response.body) {
            watchCache.set(cacheKey, { url: null, ts: Date.now() });
            return null;
        }

        // Extract iframe src: <iframe id="playerFrame" src="..." ...>
        const match = response.body.match(/<iframe[^>]*id="playerFrame"[^>]*src="([^"]+)"/i);
        if (match && match[1]) {
            const url = match[1].replace(/&amp;/g, '&');
            watchCache.set(cacheKey, { url, ts: Date.now() });
            return url;
        }

        watchCache.set(cacheKey, { url: null, ts: Date.now() });
        return null;
    } catch (err) {
        console.log(`[${PROVIDER}] getEmbedUrl failed: ${err.message}`);
        watchCache.set(cacheKey, { url: null, ts: Date.now() });
        return null;
    }
}

/**
 * Find the best match from search results for the requested title.
 */
function findBestMatch(results, title, type) {
    if (!results.length) return null;
    const expectedType = type === 'series' || type === 'tv' ? 'tv' : 'movie';
    // Filter by media type first
    const typeMatches = results.filter(r => r.media_type === expectedType);
    const candidates = typeMatches.length ? typeMatches : results;
    // Use getSortedMatches for title matching
    const mapped = candidates.map(r => ({ title: r.title, ...r }));
    const sorted = getSortedMatches(mapped, title, { minScore: 30 });
    return sorted[0] || (candidates.length ? candidates[0] : null);
}

export async function getPrimeShowsStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) {
            console.log(`[${PROVIDER}] No metadata for ${imdbId}`);
            return [];
        }

        const tmdbId = resolveTmdbId(meta);
        if (!tmdbId) {
            console.log(`[${PROVIDER}] No TMDB ID for ${imdbId} (${meta.name})`);
            return [];
        }

        const mediaType = (type === 'series' || type === 'tv') ? 'tv' : 'movie';
        const requestedSeason = mediaType === 'tv' ? (parseInt(season, 10) || 1) : null;
        const requestedEpisode = mediaType === 'tv' ? (parseInt(episode, 10) || 1) : null;

        // Verify the TMDB ID exists on PrimeShows by searching for the title
        // (some TMDB IDs may not be in their database, so we verify)
        // Also try with colons removed (search API doesn't handle colons well)
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

        let verifiedTmdbId = null;
        let verifiedTitle = null;
        for (const q of queries) {
            const results = await searchPrimeShows(q);
            const best = findBestMatch(results, meta.name, type);
            if (best && String(best.id) === String(tmdbId)) {
                verifiedTmdbId = tmdbId;
                verifiedTitle = best.title;
                break;
            }
            // If exact TMDB ID not found but we have a good title match, use that
            if (best && !verifiedTmdbId) {
                verifiedTmdbId = String(best.id);
                verifiedTitle = best.title;
            }
            if (verifiedTmdbId) break;
        }

        if (!verifiedTmdbId) {
            console.log(`[${PROVIDER}] "${meta.name}" (TMDB ${tmdbId}) not found on PrimeShows`);
            return [];
        }

        console.log(`[${PROVIDER}] Matched: ${verifiedTitle} (TMDB ${verifiedTmdbId})`);

        // Get embed URLs for all servers in parallel (limit to top 6 for speed)
        const serversToTry = SERVERS.slice(0, 6);
        const embedPromises = serversToTry.map(s =>
            getEmbedUrl(verifiedTmdbId, mediaType, requestedSeason, requestedEpisode, s.key)
                .then(url => ({ server: s, url }))
        );
        const embedResults = await Promise.all(embedPromises);

        const streams = [];
        for (const { server, url } of embedResults) {
            if (!url) continue;
            const epLabel = mediaType === 'tv'
                ? `S${requestedSeason}E${requestedEpisode}`
                : '';
            const recStar = server.recommended ? ' ⭐' : '';
            streams.push({
                name: `PhoeniX\nPrimeShows`,
                title: `${verifiedTitle}${epLabel ? ' ' + epLabel : ''}\n🔗 ${server.name}${recStar} | ${PROVIDER}`,
                externalUrl: url,
                behaviorHints: {
                    bingeGroup: `phoenix-primeshows-${server.key}`,
                    countryOfOrigin: meta.country || ''
                }
            });
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams for ${meta.name}`);
        return streams;
    } catch (err) {
        console.log(`[${PROVIDER}] Error: ${err.message}`);
        return [];
    }
}
