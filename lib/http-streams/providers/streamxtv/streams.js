/**
 * StreamX TV Provider (anime.streamxtv.tech)
 *
 * Reverse-engineered flow:
 *   1. anime.streamxtv.tech is a React SPA. Backend at https://streamx-backend-myr0.onrender.com
 *      only proxies MAL/Jikan search — no streaming API.
 *   2. The frontend embeds videos from `https://megaplay.buzz/stream/s-2/{episode_embed_id}/{sub|dub}`
 *      where episode_embed_id is an "aniwatch-style" episode ID.
 *   3. The mapping aniwatch-ep-id ↔ (anime, episode number) lives in the Anikoto API
 *      (https://anikotoapi.site) — endpoints:
 *        GET /recent-anime          -> browse list (not used here)
 *        GET /series/{anikoto_id}   -> anime metadata + episodes[{number, episode_embed_id, embed_url.{sub,dub}}]
 *   4. To find the Anikoto internal series id from an anime name, we scrape the
 *      anikototv.to /filter?keyword= search page (each result links to /watch/<slug>/ep-1,
 *      the watch page contains data-anime-id="<anikoto_id>").
 *
 * MegaPlay player pages use heavily obfuscated JS (client.js + e1-player.min.js) to
 * resolve the actual CDN URL — server-side extraction is impractical. We return the
 * player embed URL as `externalUrl` so Nuvio opens it in a webview, exactly like the
 * existing Anikoto / Miruro / Enma providers do.
 *
 * Supports: movies (anime films), series (TV anime), kdramas (when present in the
 * Anikoto catalog). Returns both SUB and DUB streams when available.
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches,
    normalizeTitle
} from '../../utils/parsing.js';

const PROVIDER = 'StreamXTV';
const ANIKOTO_SITE = (process.env.STREAMXTV_SITE_URL || 'https://anikototv.to').replace(/\/+$/, '');
const ANIKOTO_API  = (process.env.STREAMXTV_API_URL  || 'https://anikotoapi.site').replace(/\/+$/, '');
const MEGAPLAY_BASE = 'https://megaplay.buzz';

const SEARCH_CACHE_TTL = parseInt(process.env.STREAMXTV_SEARCH_CACHE_TTL || '1800000', 10); // 30 min
const SERIES_CACHE_TTL = parseInt(process.env.STREAMXTV_SERIES_CACHE_TTL || '1800000', 10); // 30 min
const DEFAULT_TIMEOUT  = parseInt(process.env.STREAMXTV_TIMEOUT || '12000', 10);

const searchCache = new Map();   // query  -> [{ title, slug, url }]
const seriesCache = new Map();   // slug   -> anikotoId
const episodesCache = new Map(); // anikotoId -> { anime, episodes[] }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 1. Search the Anikoto site to find slugs that match a query         */
/* ------------------------------------------------------------------ */
async function searchAnikoto(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return cached.data;

    const url = `${ANIKOTO_SITE}/filter?keyword=${encodeURIComponent(query)}`;
    try {
        const response = await makeRequest(url, {
            timeout: DEFAULT_TIMEOUT,
            maxRetries: 0,
            headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
        });
        if (response.statusCode !== 200 || !response.body) {
            searchCache.set(cacheKey, { data: [], ts: Date.now() });
            return [];
        }

        const $ = cheerio.load(response.body);
        const results = [];
        const seen = new Set();

        // Each result is `<a class="name d-title" href="https://anikototv.to/watch/<slug>/ep-1" data-jp="...">Title</a>`
        $('a.name.d-title, a.d-title').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
            const slugMatch = href.match(/\/watch\/([^/?#]+)/i);
            const slug = slugMatch ? slugMatch[1] : null;
            if (slug && text && !seen.has(slug)) {
                seen.add(slug);
                results.push({ title: text, slug, url: href });
            }
        });

        // Fallback: any link containing /watch/
        if (results.length === 0) {
            $('a[href*="/watch/"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
                const slugMatch = href.match(/\/watch\/([^/?#]+)/i);
                const slug = slugMatch ? slugMatch[1] : null;
                if (slug && text.length > 2 && !/^(Home|Filter|Genre|AZ-List|Schedule|Watch2gether)$/i.test(text) && !seen.has(slug)) {
                    seen.add(slug);
                    results.push({ title: text, slug, url: href });
                }
            });
        }

        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        console.log(`[${PROVIDER}] Search "${query}" → ${results.length} results`);
        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search "${query}" failed: ${err.message}`);
        searchCache.set(cacheKey, { data: [], ts: Date.now() });
        return [];
    }
}

/* ------------------------------------------------------------------ */
/* 2. Get the Anikoto internal series id from a slug                   */
/* ------------------------------------------------------------------ */
async function getSeriesIdFromSlug(slug) {
    const cached = seriesCache.get(slug);
    if (cached && Date.now() - cached.ts < SERIES_CACHE_TTL) return cached.id;

    // Try fetching the watch page and looking for data-anime-id
    const watchUrl = `${ANIKOTO_SITE}/watch/${slug}/ep-1`;
    try {
        const response = await makeRequest(watchUrl, {
            timeout: DEFAULT_TIMEOUT,
            maxRetries: 0,
            headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
        });
        if (response.statusCode === 200 && response.body) {
            // data-anime-id="786"  or  data-id="786"
            const m = response.body.match(/data-(?:anime-)?id="(\d+)"/i);
            if (m) {
                const id = m[1];
                seriesCache.set(slug, { id, ts: Date.now() });
                console.log(`[${PROVIDER}] Slug "${slug}" → series id ${id}`);
                return id;
            }
        }
    } catch (err) {
        console.log(`[${PROVIDER}] Watch page for "${slug}" failed: ${err.message}`);
    }

    // Fallback: some slugs embed a numeric suffix, but that's not the series id.
    // We can also try the API with sequential ids, but that's too slow. Return null.
    seriesCache.set(slug, { id: null, ts: Date.now() });
    return null;
}

/* ------------------------------------------------------------------ */
/* 3. Get the episodes list from the Anikoto API                       */
/* ------------------------------------------------------------------ */
async function getSeriesEpisodes(seriesId) {
    if (!seriesId) return null;
    const cached = episodesCache.get(seriesId);
    if (cached && Date.now() - cached.ts < SERIES_CACHE_TTL) return cached.data;

    const url = `${ANIKOTO_API}/series/${seriesId}`;
    try {
        const response = await makeRequest(url, {
            timeout: DEFAULT_TIMEOUT,
            maxRetries: 0,
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        });
        if (response.statusCode !== 200 || !response.body) {
            episodesCache.set(seriesId, { data: null, ts: Date.now() });
            return null;
        }
        const json = JSON.parse(response.body);
        if (!json?.ok || !json?.data) {
            episodesCache.set(seriesId, { data: null, ts: Date.now() });
            return null;
        }
        const data = {
            anime: json.data.anime || {},
            episodes: Array.isArray(json.data.episodes) ? json.data.episodes : []
        };
        episodesCache.set(seriesId, { data, ts: Date.now() });
        console.log(`[${PROVIDER}] Series ${seriesId} (${data.anime.title || '?'}) → ${data.episodes.length} episodes`);
        return data;
    } catch (err) {
        console.log(`[${PROVIDER}] API /series/${seriesId} failed: ${err.message}`);
        episodesCache.set(seriesId, { data: null, ts: Date.now() });
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* 4. Find the episode matching the requested number                   */
/* ------------------------------------------------------------------ */
function findEpisode(episodes, requestedEpisode) {
    if (!episodes || episodes.length === 0) return null;
    const epNum = parseInt(requestedEpisode, 10);
    if (!isNaN(epNum) && epNum > 0) {
        // Exact number match
        const exact = episodes.find(e => Number(e.number) === epNum);
        if (exact) return exact;
        // Try number-as-string match
        const strMatch = episodes.find(e => String(e.number) === String(requestedEpisode));
        if (strMatch) return strMatch;
    }
    // For movies (single-episode series), the episode is usually number 1 or "Full"
    if (episodes.length === 1) return episodes[0];
    // Fall back to episode 1
    const ep1 = episodes.find(e => Number(e.number) === 1);
    return ep1 || episodes[0];
}

/* ------------------------------------------------------------------ */
/* 5. Build stream entries                                              */
/* ------------------------------------------------------------------ */
function buildStreamEntry(animeMeta, episodeInfo, language) {
    if (!episodeInfo?.episode_embed_id) return null;
    const embedUrl = `${MEGAPLAY_BASE}/stream/s-2/${episodeInfo.episode_embed_id}/${language}`;
    const langLabel = language === 'dub' ? 'DUB' : 'SUB';
    const title = animeMeta?.title || 'Anime';
    const epLabel = episodeInfo?.title && episodeInfo.title.length > 0
        ? episodeInfo.title
        : `Episode ${episodeInfo.number || 1}`;
    return {
        name: `PhoeniX\nStreamXTV`,
        title: `${title} - ${epLabel}\n🔗 StreamXTV (${langLabel})`,
        externalUrl: embedUrl,
        behaviorHints: {
            bingeGroup: `phoenix-streamxtv-${language}`,
            countryOfOrigin: animeMeta?.source_country || 'JP'
        }
    };
}

/* ------------------------------------------------------------------ */
/* 6. Main entry point                                                 */
/* ------------------------------------------------------------------ */
export async function getStreamXTVStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        // StreamXTV is anime-only but we'll try any title — if no match, return []
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) {
            console.log(`[${PROVIDER}] No metadata for ${imdbId}`);
            return [];
        }

        // Build search queries (English name, name without year, original title variants)
        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...(meta.original_title ? generateAlternativeQueries(meta.name, meta.original_title) : []),
            ...(meta.original_title ? [meta.original_title] : [])
        ].filter(Boolean).map(q => q.trim()).filter(q => q.length > 1)));

        // Run searches and collect results
        const searchResults = [];
        for (const q of queries) {
            const results = await searchAnikoto(q);
            for (const r of results) {
                if (!searchResults.find(x => x.slug === r.slug)) searchResults.push(r);
            }
            if (searchResults.length >= 8) break; // Enough candidates
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No results for "${meta.name}"`);
            return [];
        }

        // Rank candidates against the requested title
        const ranked = getSortedMatches(searchResults, meta.name);
        const best = ranked[0];
        if (!best?.slug) {
            console.log(`[${PROVIDER}] No confident match for "${meta.name}"`);
            return [];
        }

        console.log(`[${PROVIDER}] Best match: ${best.title} (slug: ${best.slug})`);

        // Resolve Anikoto series ID from the slug
        const seriesId = await getSeriesIdFromSlug(best.slug);
        if (!seriesId) {
            console.log(`[${PROVIDER}] Could not resolve series id for slug "${best.slug}"`);
            return [];
        }

        // Get episodes from Anikoto API
        const seriesData = await getSeriesEpisodes(seriesId);
        if (!seriesData || seriesData.episodes.length === 0) {
            console.log(`[${PROVIDER}] No episodes for series id ${seriesId}`);
            return [];
        }

        // For movies (type === 'movie'), we want episode 1 / "Full"
        // For series, we want the requested episode number (or episode 1 as fallback)
        const requestedEpisode = (type === 'series' || type === 'tv')
            ? (episode ? parseInt(episode, 10) : 1)
            : 1;
        const episodeInfo = findEpisode(seriesData.episodes, requestedEpisode);
        if (!episodeInfo) {
            console.log(`[${PROVIDER}] Episode ${requestedEpisode} not found in series ${seriesId}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected episode: #${episodeInfo.number} (embed_id: ${episodeInfo.episode_embed_id})`);

        // Determine available languages from the episode's embed_url
        // The API may return { sub: "...", dub: "..." } or just { sub: "..." }
        const availableLangs = [];
        const embedUrls = episodeInfo.embed_url || {};
        if (embedUrls.sub) availableLangs.push('sub');
        if (embedUrls.dub) availableLangs.push('dub');
        // If embed_url is missing entirely, fall back to trying both
        if (availableLangs.length === 0) {
            availableLangs.push('sub', 'dub');
        }

        const streams = [];
        for (const lang of availableLangs) {
            const entry = buildStreamEntry(seriesData.anime, episodeInfo, lang);
            if (entry) streams.push(entry);
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} stream(s) for ${meta.name}`);
        return streams;
    } catch (err) {
        console.log(`[${PROVIDER}] Error: ${err.message}`);
        return [];
    }
}
