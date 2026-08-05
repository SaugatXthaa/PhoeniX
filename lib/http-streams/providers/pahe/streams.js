/**
 * Pahe Streams Provider (pahe.ink)
 * Search → post page → teknoasian.com server links (PD/VF/GD/MG)
 * teknoasian.com links are wrapped with resolver (needs FlareSolverr)
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'Pahe';
const BASE_URL = (process.env.PAHE_BASE_URL || 'https://pahe.ink').replace(/\/+$/, '');
const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const PAGE_CACHE_TTL = 10 * 60 * 1000;
const searchCache = new Map();
const pageCache = new Map();
const SERVER_NAMES = { 'PD': 'PixelDrain', 'VF': 'Voe', 'GD': 'GDrive', 'MG': 'Mega', '1F': '1Fichier' };

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchPahe(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return cached.data;
    try {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        const response = await makeRequest(searchUrl, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.statusCode !== 200) return [];
        const $ = response.document;
        const results = [];
        $('.post, article, .entry, .cat-post').each((_, el) => {
            const $el = $(el);
            const link = $el.find('h2 a, h3 a, .entry-title a, .post-title a, a[href*="pahe.ink/"]').first();
            const href = link.attr('href');
            const title = cleanText(link.text());
            if (href && title && href.includes('pahe.ink/') && !href.includes('?s=') && !href.includes('/category/') && !href.includes('/page/'))
                results.push({ title, url: href });
        });
        if (results.length === 0) {
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                const text = cleanText($(el).text());
                if (href && text.length > 10 && href.includes('pahe.ink/') && !href.includes('?s=') && !href.includes('/category/') && !href.includes('/page/') && !href.includes('/feed/'))
                    results.push({ title: text, url: href });
            });
        }
        const seen = new Set();
        const unique = results.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
        searchCache.set(cacheKey, { data: unique, ts: Date.now() });
        return unique;
    } catch { return []; }
}

async function loadPahePost(postUrl, isSeries, season, episode) {
    const cached = pageCache.get(postUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) return cached.data;
    try {
        const response = await makeRequest(postUrl, { parseHTML: true, timeout: 15000, maxRetries: 0, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.statusCode !== 200) return null;
        const $ = response.document;
        const pageTitle = $('h1.entry-title, h1.post-title, h1').first().text().trim();
        const pageLanguages = detectLanguagesFromTitle(pageTitle);
        const downloadLinks = [];
        $('a[href*="teknoasian.com"]').each((_, el) => {
            const href = $(el).attr('href');
            const serverCode = cleanText($(el).text()).toUpperCase();
            if (!href || !serverCode) return;
            const parent = $(el).closest('div, p, li, td, tr').first();
            const context = cleanText(parent.text());
            let quality = 'auto';
            if (/2160p|4k|uhd/i.test(context)) quality = '2160p';
            else if (/1080p/i.test(context)) quality = '1080p';
            else if (/720p/i.test(context)) quality = '720p';
            else if (/480p/i.test(context)) quality = '480p';
            const sizeMatch = context.match(/([\d.]+)\s*(GB|MB)/i);
            const size = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null;
            if (isSeries && season && episode) {
                const epMatch = context.match(/S0*(\d+)\s*E0*(\d+)/i);
                if (epMatch) { if (parseInt(epMatch[1]) !== parseInt(season) || parseInt(epMatch[2]) !== parseInt(episode)) return; }
            }
            const serverName = SERVER_NAMES[serverCode] || serverCode;
            downloadLinks.push({ url: href, server: serverName, serverCode, quality, size, label: `Pahe [${serverName}]`, languages: pageLanguages });
        });
        pageCache.set(postUrl, { data: downloadLinks, ts: Date.now() });
        return downloadLinks;
    } catch { return null; }
}

export async function getPaheStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const isSeries = type === 'series' || type === 'tv';
        const queries = Array.from(new Set([meta.name, removeYear(meta.name), ...generateAlternativeQueries(meta.name, meta.original_title || '')].filter(Boolean)));
        let bestMatch = null;
        for (const query of queries) {
            const results = await searchPahe(query);
            if (results.length > 0) {
                const sorted = getSortedMatches(results, meta.name, { minScore: 20 });
                if (sorted.length > 0) { bestMatch = sorted[0]; break; }
                if (!bestMatch) bestMatch = results[0];
            }
        }
        if (!bestMatch) return [];
        const downloadLinks = await loadPahePost(bestMatch.url, isSeries, season, episode);
        if (!downloadLinks || downloadLinks.length === 0) return [];
        return downloadLinks.map(link => {
            const qualityLabel = link.quality === '2160p' ? '4k' : link.quality;
            const langFlags = renderLanguageFlags(link.languages || []);
            const sizeInfo = link.size ? `💾 ${link.size}` : '';
            return {
                name: `PhoeniX\n${qualityLabel}`,
                title: `${bestMatch.title} ${link.label}\n${langFlags} ${sizeInfo} | ${PROVIDER}`.trim(),
                url: link.url,
                behaviorHints: { notWebReady: true, bingeGroup: `phoenix-pahe-${qualityLabel}-${link.serverCode}` }
            };
        });
    } catch (error) { return []; }
}
