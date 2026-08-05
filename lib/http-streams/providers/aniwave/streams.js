/**
 * AniWave Provider (aniwave.dk) — Anime streaming
 * Search: /search?keyword=<query> → /anime/<slug>
 * Returns embed URL for Nuvio webview
 * Anime-only (series)
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { removeYear } from '../../utils/parsing.js';

const PROVIDER = 'AniWave';
const BASE_URL = (process.env.ANIWAVE_BASE_URL || 'https://aniwave.dk').replace(/\/+$/, '');
const searchCache = new Map(); const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchAniWave(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        const resp = await makeRequest(`${BASE_URL}/search?keyword=${encodeURIComponent(query)}`, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const results = [];
        $('a[href*="/anime/"]').each((_, el) => {
            const href = $(el).attr('href'); const text = cleanText($(el).text());
            if (href && text.length > 1 && !href.includes('/anime/?')) {
                const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
                if (!results.find(r => r.url === fullUrl)) results.push({ title: text, url: fullUrl });
            }
        });
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

export async function getAniWaveStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        if (type !== 'series' && type !== 'tv') return [];
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const queries = [meta.name, removeYear(meta.name), ...(meta.original_title ? [meta.original_title] : [])].filter(Boolean);
        let bestMatch = null;
        for (const q of queries) {
            const results = await searchAniWave(q);
            if (results.length > 0) { bestMatch = results[0]; break; }
        }
        if (!bestMatch) return [];
        const reqEp = episode ? parseInt(episode) : 1;
        const watchUrl = `${bestMatch.url}?ep=${reqEp}`;
        console.log(`[${PROVIDER}] Returning embed: ${watchUrl}`);
        return [{
            name: `PhoeniX\nAniWave`,
            title: `${bestMatch.title} - Episode ${reqEp}\n🔗 AniWave (embed)`,
            externalUrl: watchUrl,
            behaviorHints: { bingeGroup: 'phoenix-aniwave' }
        }];
    } catch { return []; }
}
