/**
 * MoviesEQ Provider (movieseq.com) — soap2day-style
 * Movies + TV Shows with JS player
 * Search: /movies?q=<query> → /movie/<slug> pages
 * Streams loaded via JS player — returns embed URL
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'MoviesEQ';
const BASE_URL = (process.env.MOVIESEQ_BASE_URL || 'https://movieseq.com').replace(/\/+$/, '');
const searchCache = new Map(); const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchMoviesEQ(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        const resp = await makeRequest(`${BASE_URL}/movies?q=${encodeURIComponent(query)}`, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const results = [];
        $('a[href*="/movie/"]').each((_, el) => {
            const href = $(el).attr('href'); const text = cleanText($(el).text());
            if (href && text.length > 2) {
                const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
                if (!results.find(r => r.url === fullUrl)) results.push({ title: text, url: fullUrl });
            }
        });
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

export async function getMoviesEQStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        let bestMatch = null;
        for (const q of [meta.name, removeYear(meta.name), ...generateAlternativeQueries(meta.name, meta.original_title || '')].filter(Boolean)) {
            const results = await searchMoviesEQ(q);
            if (results.length > 0) { const sorted = getSortedMatches(results, meta.name, { minScore: 15 }); bestMatch = sorted[0] || results[0]; if (bestMatch) break; }
        }
        if (!bestMatch) return [];
        // Return embed URL — player loads streams via JS
        return [{
            name: `PhoeniX\nMoviesEQ`,
            title: `${bestMatch.title}\n🔗 MoviesEQ (embed)`,
            externalUrl: bestMatch.url,
            behaviorHints: { bingeGroup: 'phoenix-movieseq' }
        }];
    } catch { return []; }
}
