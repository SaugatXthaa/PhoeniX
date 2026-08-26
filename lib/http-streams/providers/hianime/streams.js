/**
 * HiAnime Provider (hianime.win)
 *
 * Reverse-engineered flow:
 *   1. Search: GET /search?keyword=<query> → HTML with <a href="/watch/<slug>-<id>">
 *   2. Watch page: GET /watch/<slug>-<id>
 *      Contains episode list: <a class="ssl-item ep-item" data-number="1" data-id="81731" href="/watch/<slug>/episode/1">
 *   3. Episode page: GET /watch/<slug>-<id>/episode/<num>
 *      Contains server list: <div class="item server-item" data-type="sub|dub" data-url="<embed_url>">
 *
 * Server URLs are direct embed pages (gn1r5n.org, playmogo.com, etc.) that
 * load video players via JS. We return them as externalUrl for Nuvio's webview.
 *
 * Anime-only (series + anime movies). Returns SUB and DUB streams when available.
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'HiAnime';
const BASE_URL = (process.env.HIANIME_BASE_URL || 'https://hianime.win').replace(/\/+$/, '');

const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const PAGE_CACHE_TTL = 10 * 60 * 1000;
const searchCache = new Map();
const episodeListCache = new Map();
const serverCache = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

/**
 * Search HiAnime for a query.
 * Returns array of { title, slug, id, url }
 */
async function searchHiAnime(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return cached.data;

    try {
        const url = `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`;
        const response = await makeRequest(url, {
            timeout: 12000,
            maxRetries: 0,
            headers: REQUEST_HEADERS,
            parseHTML: true
        });

        if (response.statusCode !== 200 || !response.document) {
            searchCache.set(cacheKey, { data: [], ts: Date.now() });
            return [];
        }

        const $ = response.document;
        const results = [];
        const seen = new Set();

        // Each result is <a class="dynamic-name" href="/watch/<slug>-<id>" title="..."> inside .flw-item
        $('.flw-item a[href*="/watch/"]').each((_, el) => {
            const $el = $(el);
            const href = $el.attr('href') || '';
            const match = href.match(/\/watch\/([^/]+)-(\d+)/);
            if (!match) return;
            const slug = match[1];
            const id = match[2];
            if (seen.has(id)) return;
            seen.add(id);

            // Get title from the title attribute, data-jname, or text
            const title = ($el.attr('title') || $el.attr('data-jname') || $el.text() || slug.replace(/-/g, ' '))
                .replace(/\s+/g, ' ').trim();

            if (title.length > 1) {
                results.push({
                    title,
                    slug,
                    id,
                    url: `${BASE_URL}/watch/${slug}-${id}`
                });
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
 * Get the episode list for an anime.
 * Returns array of { number, id, url }
 */
async function getEpisodeList(animeSlug, animeId) {
    const cacheKey = `${animeId}`;
    const cached = episodeListCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) return cached.data;

    try {
        const url = `${BASE_URL}/watch/${animeSlug}-${animeId}`;
        const response = await makeRequest(url, {
            timeout: 12000,
            maxRetries: 0,
            headers: REQUEST_HEADERS,
            parseHTML: true
        });

        if (response.statusCode !== 200 || !response.document) {
            episodeListCache.set(cacheKey, { data: [], ts: Date.now() });
            return [];
        }

        const $ = response.document;
        const episodes = [];

        // Episodes: <a class="ssl-item ep-item" data-number="1" data-id="81731" href="/watch/<slug>/episode/1">
        $('.ssl-item.ep-item').each((_, el) => {
            const $el = $(el);
            const number = parseInt($el.attr('data-number'), 10);
            const id = $el.attr('data-id');
            const href = $el.attr('href') || '';
            if (number && id) {
                episodes.push({
                    number,
                    id,
                    url: `${BASE_URL}${href}`
                });
            }
        });

        // Sort by episode number
        episodes.sort((a, b) => a.number - b.number);
        episodeListCache.set(cacheKey, { data: episodes, ts: Date.now() });
        console.log(`[${PROVIDER}] Anime ${animeId} → ${episodes.length} episodes`);
        return episodes;
    } catch (err) {
        console.log(`[${PROVIDER}] Episode list failed: ${err.message}`);
        episodeListCache.set(cacheKey, { data: [], ts: Date.now() });
        return [];
    }
}

/**
 * Get the servers (embed URLs) for a specific episode.
 * Returns array of { type: 'sub'|'dub', name, url }
 */
async function getEpisodeServers(animeSlug, animeId, episodeNumber) {
    const cacheKey = `${animeId}:${episodeNumber}`;
    const cached = serverCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) return cached.data;

    try {
        const url = `${BASE_URL}/watch/${animeSlug}-${animeId}/episode/${episodeNumber}`;
        const response = await makeRequest(url, {
            timeout: 12000,
            maxRetries: 0,
            headers: REQUEST_HEADERS,
            parseHTML: true
        });

        if (response.statusCode !== 200 || !response.document) {
            serverCache.set(cacheKey, { data: [], ts: Date.now() });
            return [];
        }

        const $ = response.document;
        const servers = [];

        // Servers: <div class="item server-item" data-type="sub" data-url="<embed_url>">
        $('.item.server-item').each((_, el) => {
            const $el = $(el);
            const type = $el.attr('data-type') || 'sub';
            const embedUrl = $el.attr('data-url');
            const name = $el.find('a').first().text().trim() || type.toUpperCase();
            if (embedUrl && embedUrl.startsWith('http')) {
                servers.push({ type, name, url: embedUrl });
            }
        });

        serverCache.set(cacheKey, { data: servers, ts: Date.now() });
        console.log(`[${PROVIDER}] Episode ${episodeNumber} → ${servers.length} servers`);
        return servers;
    } catch (err) {
        console.log(`[${PROVIDER}] Servers failed: ${err.message}`);
        serverCache.set(cacheKey, { data: [], ts: Date.now() });
        return [];
    }
}

export async function getHiAnimeStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) {
            console.log(`[${PROVIDER}] No metadata for ${imdbId}`);
            return [];
        }

        // Build search queries
        // Also try with colons removed (HiAnime search doesn't handle colons well)
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
            const results = await searchHiAnime(q);
            if (results.length === 0) continue;
            const sorted = getSortedMatches(results, meta.name, { minScore: 40 });
            if (sorted.length > 0) {
                bestMatch = sorted[0];
                break;
            }
            if (!bestMatch) bestMatch = results[0];
        }

        if (!bestMatch) {
            console.log(`[${PROVIDER}] No match for "${meta.name}"`);
            return [];
        }

        console.log(`[${PROVIDER}] Matched: ${bestMatch.title} (id: ${bestMatch.id})`);

        // Get episode list
        const episodes = await getEpisodeList(bestMatch.slug, bestMatch.id);
        if (episodes.length === 0) {
            console.log(`[${PROVIDER}] No episodes for ${bestMatch.title}`);
            return [];
        }

        // For movies (single episode), use episode 1
        // For series, use the requested episode number
        let requestedEpisode;
        if (type === 'series' || type === 'tv') {
            const epNum = parseInt(episode, 10) || 1;
            const found = episodes.find(e => e.number === epNum);
            requestedEpisode = found || episodes[0];
        } else {
            // Movie — use first episode
            requestedEpisode = episodes[0];
        }

        if (!requestedEpisode) {
            console.log(`[${PROVIDER}] Episode not found`);
            return [];
        }

        console.log(`[${PROVIDER}] Episode: #${requestedEpisode.number}`);

        // Get servers for the episode
        const servers = await getEpisodeServers(bestMatch.slug, bestMatch.id, requestedEpisode.number);
        if (servers.length === 0) {
            console.log(`[${PROVIDER}] No servers for episode ${requestedEpisode.number}`);
            return [];
        }

        // Build streams — deduplicate by URL (some servers share the same embed URL)
        const seen = new Set();
        const streams = [];
        for (const server of servers) {
            if (seen.has(server.url)) continue;
            seen.add(server.url);
            const langLabel = server.type === 'dub' ? 'DUB' : 'SUB';
            const epLabel = `E${requestedEpisode.number}`;
            streams.push({
                name: `PhoeniX\nHiAnime`,
                title: `${bestMatch.title} ${epLabel}\n🔗 ${server.name} (${langLabel}) | ${PROVIDER}`,
                externalUrl: server.url,
                behaviorHints: {
                    bingeGroup: `phoenix-hianime-${server.type}`,
                    countryOfOrigin: 'JP'
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
