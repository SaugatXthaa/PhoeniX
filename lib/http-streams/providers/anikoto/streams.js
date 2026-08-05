/**
 * Anikoto Streams Provider
 *
 * Anikoto (anikototv.to) is an anime streaming site.
 * Search: /filter?keyword=<query>
 * Watch page: /watch/<slug>/ep-<episode>
 *
 * The site uses a complex JS-based stream loading system (nekostream.site)
 * that can't be replicated server-side. Returns externalUrl (embed) for
 * Nuvio to open in a webview.
 *
 * Anime-only (series).
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';

const PROVIDER = 'Anikoto';
const BASE_URL = (process.env.ANIKOTO_BASE_URL || 'https://anikototv.to').replace(/\/+$/, '');
const SEARCH_TIMEOUT = parseInt(process.env.ANIKOTO_TIMEOUT || '12000', 10);

const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function searchAnikoto(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

    try {
        const searchUrl = `${BASE_URL}/filter?keyword=${encodeURIComponent(query)}`;
        const response = await makeRequest(searchUrl, {
            timeout: SEARCH_TIMEOUT, maxRetries: 0,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (response.statusCode !== 200) return [];
        const $ = cheerio.load(response.body);

        const results = [];
        $('a[href*="/watch/"]').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && text.length > 3) {
                // Extract slug from URL: /watch/<slug>/ep-1
                const slugMatch = href.match(/\/watch\/([^/]+)/);
                const slug = slugMatch ? slugMatch[1] : null;
                if (slug) {
                    // Only add unique slugs
                    if (!results.find(r => r.slug === slug)) {
                        results.push({ title: text.replace(/\s+/g, ' ').trim(), slug, url: href });
                    }
                }
            }
        });

        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        console.log(`[${PROVIDER}] Search "${query}" returned ${results.length} results`);
        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search failed: ${err.message}`);
        return [];
    }
}

function findBestMatch(results, title) {
    if (!results.length) return null;
    const titleLower = title.toLowerCase();
    const exact = results.find(r => r.title.toLowerCase() === titleLower);
    if (exact) return exact;
    const contains = results.find(r => r.title.toLowerCase().includes(titleLower) || titleLower.includes(r.title.toLowerCase()));
    return contains || results[0];
}

export async function getAnikotoStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        if (type !== 'series' && type !== 'tv') {
            console.log(`[${PROVIDER}] Skipping non-series request`);
            return [];
        }

        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        // Search — try both English and original title
        let searchResults = await searchAnikoto(meta.name);
        if (searchResults.length === 0 && meta.original_title) {
            searchResults = await searchAnikoto(meta.original_title);
        }
        if (searchResults.length === 0) return [];

        const bestMatch = findBestMatch(searchResults, meta.name);
        if (!bestMatch) return [];

        console.log(`[${PROVIDER}] Selected: ${bestMatch.title} (slug: ${bestMatch.slug})`);

        // Build watch URL for the requested episode
        const requestedEpisode = episode ? parseInt(episode) : 1;
        const watchUrl = `${BASE_URL}/watch/${bestMatch.slug}/ep-${requestedEpisode}`;

        // Return as externalUrl — Nuvio opens it in a webview
        return [{
            name: `PhoeniX\nAnikoto`,
            title: `${bestMatch.title} - Episode ${requestedEpisode}\n🔗 Anikoto (embed)`,
            externalUrl: watchUrl,
            behaviorHints: { bingeGroup: 'phoenix-anikoto' }
        }];
    } catch (error) {
        console.log(`[${PROVIDER}] Error: ${error.message}`);
        return [];
    }
}
