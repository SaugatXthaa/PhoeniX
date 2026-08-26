/**
 * UHDMovies Provider (uhdmovies.casa → uhdmovies.autos)
 * WordPress DDL: ?s=<query> → /download-<slug>.html → HubCloud/gadgetsweb links
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'UHDMovies';
const BASE_URL = (process.env.UHDMOVIES_BASE_URL || 'https://uhdmovies.autos').replace(/\/+$/, '');
const REDIRECTOR_PATTERNS = ['gadgetsweb', 'hubcloud', 'hubdrive', 'hubcdn', 'hblinks', 'gdtot', 'fastream', 'modpro', 'leechpro', 'driveseed', 'driveleech'];
const searchCache = new Map(); const pageCache = new Map(); const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchUHDMovies(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        const resp = await makeRequest(`${BASE_URL}/?s=${encodeURIComponent(query)}`, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const results = [];
        $('a[href*="uhdmovies"]').each((_, el) => {
            const href = $(el).attr('href'); const text = cleanText($(el).text());
            if (href && text.length > 5 && href.includes('.html') && !href.includes('?s=') && !href.includes('/category/'))
                if (!results.find(r => r.url === href)) results.push({ title: text, url: href });
        });
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

export async function getUHDMoviesStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const isSeries = type === 'series' || type === 'tv';
        let bestMatch = null;
        for (const q of [meta.name, removeYear(meta.name), ...generateAlternativeQueries(meta.name, meta.original_title || '')].filter(Boolean)) {
            const results = await searchUHDMovies(q);
            if (results.length > 0) { const sorted = getSortedMatches(results, meta.name, { minScore: 15 }); bestMatch = sorted[0] || results[0]; if (bestMatch) break; }
        }
        if (!bestMatch) return [];
        const cached = pageCache.get(bestMatch.url);
        if (cached && Date.now() - cached.ts < TTL) return cached.data;
        const resp = await makeRequest(bestMatch.url, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.statusCode !== 200) return [];
        const $ = resp.document;
        const pageTitle = $('h1').first().text().trim();
        const pageLangs = detectLanguagesFromTitle(pageTitle);
        const links = [];
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href'); const text = cleanText($(el).text());
            if (!href || !text) return;
            if (!REDIRECTOR_PATTERNS.some(p => href.toLowerCase().includes(p))) return;
            const parent = $(el).closest('div, p, li, td, h4, h3').first();
            const ctx = cleanText(parent.text());
            let quality = 'auto';
            if (/2160p|4k/i.test(ctx)) quality = '2160p'; else if (/1080p/i.test(ctx)) quality = '1080p'; else if (/720p/i.test(ctx)) quality = '720p'; else if (/480p/i.test(ctx)) quality = '480p';
            const sizeMatch = ctx.match(/([\d.]+)\s*(GB|MB)/i);
            if (isSeries && season && episode) { const ep = ctx.match(/S0*(\d+)\s*E0*(\d+)/i); if (ep && parseInt(ep[2]) !== parseInt(episode)) return; }
            links.push({ url: href, label: text, quality, size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null, languages: pageLangs });
        });
        const streams = links.map(l => ({
            name: `PhoeniX\n${l.quality === '2160p' ? '4k' : l.quality}`,
            title: `${bestMatch.title} ${l.label}\n${renderLanguageFlags(l.languages || [])} ${l.size ? '💾 ' + l.size : ''} | ${PROVIDER}`.trim(),
            url: l.url, behaviorHints: { notWebReady: true, bingeGroup: `phoenix-uhdmovies-${l.quality}` }
        }));
        pageCache.set(bestMatch.url, { data: streams, ts: Date.now() });
        return streams;
    } catch { return []; }
}
