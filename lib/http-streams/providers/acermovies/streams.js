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
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...(meta.original_title ? [meta.original_title] : [])
        ].filter(Boolean).map(q => q.trim()).filter(q => q.length > 1)));

        let bestMatch = null;
        for (const q of queries) {
            const results = await searchAcerMovies(q);
            if (results.length === 0) continue;
            const sorted = getSortedMatches(results, meta.name, { minScore: 30 });
            if (sorted.length > 0) { bestMatch = sorted[0]; break; }
            if (!bestMatch) bestMatch = results[0];
        }

        if (!bestMatch?.url) {
            console.log(`[${PROVIDER}] No match for "${meta.name}"`);
            return [];
        }

        console.log(`[${PROVIDER}] Matched: ${bestMatch.title}`);

        const qualityLinks = await getQualityLinks(bestMatch.url);
        if (qualityLinks.length === 0) {
            console.log(`[${PROVIDER}] No quality links`);
            return [];
        }

        // For series, filter by episode
        const isSeries = type === 'series' || type === 'tv';
        const streams = [];
        for (const link of qualityLinks) {
            // Skip if it's an episode list or batch (we want direct movie links)
            if (link.episodesUrl || link.batchUrl) continue;

            const qualityLabel = link.quality === '2160p' ? '4k' : link.quality || 'auto';
            const sizeMatch = link.title.match(/\[([^\]]*(?:MB|GB)[^\]]*)\]/i);
            const size = sizeMatch ? sizeMatch[1].trim() : null;

            // modpro.blog links go through dead redirectors (cloud.unblockedgames.world)
            // that don't resolve to video URLs. Return as externalUrl so user opens
            // in browser to download manually, instead of causing MPV errors.
            const isModpro = link.url && (link.url.includes('modpro.blog') || link.url.includes('links.modpro') || link.url.includes('posts.modpro'));

            if (isModpro) {
                streams.push({
                    name: `PhoeniX\n${qualityLabel}`,
                    title: `${link.title.replace(/\s*\[.*?\]\s*/g, ' ').trim()}\n${size ? '💾 ' + size + ' | ' : ''}${PROVIDER}`,
                    externalUrl: link.url,
                    behaviorHints: {
                        bingeGroup: `phoenix-acermovies-${qualityLabel}`
                    }
                });
            } else {
                streams.push({
                    name: `PhoeniX\n${qualityLabel}`,
                    title: `${link.title.replace(/\s*\[.*?\]\s*/g, ' ').trim()}\n${size ? '💾 ' + size + ' | ' : ''}${PROVIDER}`,
                    url: encodeUrlForStreaming(link.url),
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `phoenix-acermovies-${qualityLabel}`
                    }
                });
            }
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams for ${meta.name}`);
        return streams;
    } catch (err) {
        console.log(`[${PROVIDER}] Error: ${err.message}`);
        return [];
    }
}
