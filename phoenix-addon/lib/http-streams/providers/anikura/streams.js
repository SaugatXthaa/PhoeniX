/**
 * Anikura Streams Provider
 *
 * Anikura (anikura.club) is a Next.js anime streaming site.
 * API: /api/search?q=<query> → anime list
 * API: /api/watch/streams?id=<id>&ep=<episode>&lang=<sub|dub> → HLS streams
 * Returns HLS .m3u8 URLs — Nuvio's MPV plays these natively.
 * Anime-only (series).
 */

import Cinemeta from '../../../util/cinemeta.js';
import { makeRequest } from '../../utils/http.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';

const PROVIDER = 'Anikura';
const BASE_URL = (process.env.ANIKURA_BASE_URL || 'https://anikura.club').replace(/\/+$/, '');
const API_TIMEOUT = parseInt(process.env.ANIKURA_TIMEOUT || '15000', 10);

const searchCache = new Map();
const streamCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function searchAnikura(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
    try {
        const searchUrl = `${BASE_URL}/api/search?q=${encodeURIComponent(query)}`;
        const response = await makeRequest(searchUrl, {
            timeout: API_TIMEOUT, maxRetries: 0,
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        if (response.statusCode !== 200) return [];
        const data = JSON.parse(response.body);
        const results = (data.results || []).map(a => ({
            key: a.key, title: a.title, href: a.href,
            animeId: a.key.replace('c-', '')
        }));
        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        console.log(`[${PROVIDER}] Search "${query}" returned ${results.length} results`);
        return results;
    } catch (err) { return []; }
}

async function fetchEpisodeStreams(animeId, episode, lang = 'sub') {
    const cacheKey = `${animeId}:${episode}:${lang}`;
    const cached = streamCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
    try {
        const streamUrl = `${BASE_URL}/api/watch/streams?id=${animeId}&ep=${episode}&lang=${lang}`;
        const response = await makeRequest(streamUrl, {
            timeout: API_TIMEOUT, maxRetries: 0,
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': `${BASE_URL}/` }
        });
        if (response.statusCode !== 200) return [];
        const data = JSON.parse(response.body);
        const streams = (data.streams || []).map(s => {
            let url = s.url || '';
            if (url.startsWith('/')) url = BASE_URL + url;
            return { id: s.id, label: s.label, language: s.language, kind: s.kind, url };
        });
        streamCache.set(cacheKey, { data: streams, ts: Date.now() });
        return streams;
    } catch (err) { return []; }
}

function findBestMatch(results, title) {
    if (!results.length) return null;
    const titleLower = title.toLowerCase();
    const exact = results.find(r => r.title.toLowerCase() === titleLower);
    if (exact) return exact;
    const contains = results.find(r => r.title.toLowerCase().includes(titleLower) || titleLower.includes(r.title.toLowerCase()));
    return contains || results[0];
}

export async function getAnikuraStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        if (type !== 'series' && type !== 'tv') { console.log(`[${PROVIDER}] Skipping non-series request`); return []; }
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        const searchResults = await searchAnikura(meta.name);
        if (searchResults.length === 0 && meta.original_title) {
            const altResults = await searchAnikura(meta.original_title);
            searchResults.push(...altResults);
        }
        if (searchResults.length === 0) return [];

        const bestMatch = findBestMatch(searchResults, meta.name);
        if (!bestMatch) return [];

        const requestedEpisode = episode ? parseInt(episode) : 1;
        const allStreams = [];
        const subStreams = await fetchEpisodeStreams(bestMatch.animeId, requestedEpisode, 'sub');
        subStreams.forEach(s => allStreams.push({ url: s.url, label: `${s.label} (Sub)`, kind: s.kind }));
        const dubStreams = await fetchEpisodeStreams(bestMatch.animeId, requestedEpisode, 'dub');
        dubStreams.forEach(s => allStreams.push({ url: s.url, label: `${s.label} (Dub)`, kind: s.kind }));

        if (allStreams.length === 0) return [];

        const streams = allStreams.map(s => ({
            name: `PhoeniX\nauto`,
            title: `${bestMatch.title} - Episode ${requestedEpisode}\n${s.label} | ${PROVIDER}`,
            url: s.url,
            behaviorHints: { notWebReady: true, bingeGroup: `phoenix-anikura-${s.label.replace(/\s+/g, '-').toLowerCase()}` }
        }));
        console.log(`[${PROVIDER}] Returning ${streams.length} stream(s)`);
        return streams;
    } catch (error) { console.log(`[${PROVIDER}] Error: ${error.message}`); return []; }
}
