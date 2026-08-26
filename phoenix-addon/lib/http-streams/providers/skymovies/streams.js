/**
 * SkyMoviesHD Streams Provider (skymovieshd.ceo)
 * Search: /search.php?search=<query>
 * Movie page: /movie/<slug>.html
 * Download links: howblogs.xyz/<id> redirectors → resolver
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'SkyMoviesHD';
const BASE_URL = (process.env.SKYMOVIES_BASE_URL || 'https://skymovieshd.ceo').replace(/\/+$/, '');
const searchCache = new Map(); const pageCache = new Map();
const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchSkyMovies(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        const url = `${BASE_URL}/search.php?search=${encodeURIComponent(query)}`;
        const resp = await makeRequest(url, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const results = [];
        $('a[href*="/movie/"]').each((_, el) => {
            const href = $(el).attr('href');
            const text = cleanText($(el).text());
            if (href && text.length > 3) {
                const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
                results.push({ title: text, url: fullUrl });
            }
        });
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

async function loadSkyMoviesPost(postUrl) {
    const cached = pageCache.get(postUrl);
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        const resp = await makeRequest(postUrl, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const pageTitle = $('title').text().trim();
        const pageLangs = detectLanguagesFromTitle(pageTitle);
        const links = [];
        $('a[href*="howblogs.xyz"], a[href*="drive"], a[href*="download"]').each((_, el) => {
            const href = $(el).attr('href');
            const text = cleanText($(el).text());
            if (!href || !text) return;
            let quality = 'auto';
            if (/2160p|4k/i.test(text)) quality = '2160p';
            else if (/1080p/i.test(text)) quality = '1080p';
            else if (/720p/i.test(text)) quality = '720p';
            else if (/480p/i.test(text)) quality = '480p';
            const sizeMatch = text.match(/([\d.]+)\s*(GB|MB)/i);
            links.push({ url: href, label: text, quality, size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null, languages: pageLangs });
        });
        pageCache.set(postUrl, { data: links, ts: Date.now() });
        return links;
    } catch { return []; }
}

export async function getSkyMoviesStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        let bestMatch = null;
        for (const q of [meta.name, removeYear(meta.name), ...generateAlternativeQueries(meta.name, meta.original_title || '')].filter(Boolean)) {
            const results = await searchSkyMovies(q);
            if (results.length > 0) { const sorted = getSortedMatches(results, meta.name, { minScore: 15 }); bestMatch = sorted[0] || results[0]; if (bestMatch) break; }
        }
        if (!bestMatch) return [];
        const links = await loadSkyMoviesPost(bestMatch.url);
        if (!links.length) return [];
        return links.map(l => ({
            name: `PhoeniX\n${l.quality === '2160p' ? '4k' : l.quality}`,
            title: `${bestMatch.title} ${l.label}\n${renderLanguageFlags(l.languages || [])} ${l.size ? '💾 ' + l.size : ''} | ${PROVIDER}`.trim(),
            url: l.url, behaviorHints: { notWebReady: true, bingeGroup: `phoenix-skymovies-${l.quality}` }
        }));
    } catch { return []; }
}
