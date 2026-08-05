/**
 * AniWaves Provider (aniwaves.ru) — Anime streaming
 * Search: /filter?keyword=<query> → /watch/<slug>
 * Returns embed URL for Nuvio webview
 * Anime-only (series)
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'AniWaves';
const BASE_URL = (process.env.ANIWAVES_BASE_URL || 'https://aniwaves.ru').replace(/\/+$/, '');
const searchCache = new Map(); const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchAniWaves(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        const resp = await makeRequest(`${BASE_URL}/filter?keyword=${encodeURIComponent(query)}`, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const results = [];
        $('a[href*="/watch/"]').each((_, el) => {
            const href = $(el).attr('href'); const text = cleanText($(el).text());
            if (href && text.length > 1) {
                const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
                if (!results.find(r => r.url === fullUrl)) results.push({ title: text, url: fullUrl });
            }
        });
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

export async function getAniWavesStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        if (type !== 'series' && type !== 'tv') return [];
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const queries = [meta.name, removeYear(meta.name), ...(meta.original_title ? [meta.original_title] : [])].filter(Boolean);
        let bestMatch = null;
        for (const q of queries) {
            const results = await searchAniWaves(q);
            if (results.length > 0) { bestMatch = results[0]; break; }
        }
        if (!bestMatch) return [];
        const reqEp = episode ? parseInt(episode) : 1;
        const watchUrl = `${bestMatch.url}?ep=${reqEp}`;
        console.log(`[${PROVIDER}] Returning embed: ${watchUrl}`);
        return [{
            name: `PhoeniX\nAniWaves`,
            title: `${bestMatch.title} - Episode ${reqEp}\n🔗 AniWaves (embed)`,
            externalUrl: watchUrl,
            behaviorHints: { bingeGroup: 'phoenix-aniwaves' }
        }];
    } catch { return []; }
}
