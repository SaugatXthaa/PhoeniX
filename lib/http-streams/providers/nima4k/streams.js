/**
 * Nima4K Provider (nima4k.org) — German movies/series
 * Search: /search/<query> → /release/<id>/<slug> pages
 * Download links are behind login — returns embed URL
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'Nima4K';
const BASE_URL = (process.env.NIMA4K_BASE_URL || 'https://nima4k.org').replace(/\/+$/, '');
const searchCache = new Map(); const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchNima4K(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        const resp = await makeRequest(`${BASE_URL}/search/${encodeURIComponent(query)}`, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const results = [];
        $('a[href*="/release/"]').each((_, el) => {
            const href = $(el).attr('href'); const text = cleanText($(el).text());
            if (href && text.length > 3) {
                const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
                if (!results.find(r => r.url === fullUrl)) results.push({ title: text, url: fullUrl });
            }
        });
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

export async function getNima4KStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const queries = [meta.name, removeYear(meta.name), ...generateAlternativeQueries(meta.name, meta.original_title || '')].filter(Boolean);
        let bestMatch = null;
        for (const q of queries) {
            const results = await searchNima4K(q);
            if (results.length > 0) { const sorted = getSortedMatches(results, meta.name, { minScore: 15 }); bestMatch = sorted[0] || results[0]; if (bestMatch) break; }
        }
        if (!bestMatch) return [];
        // Return embed URL — download links are behind login
        return [{
            name: `PhoeniX\nNima4K`,
            title: `${bestMatch.title}\n🔗 Nima4K (German)`,
            externalUrl: bestMatch.url,
            behaviorHints: { bingeGroup: 'phoenix-nima4k' }
        }];
    } catch { return []; }
}
