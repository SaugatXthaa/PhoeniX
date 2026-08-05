/**
 * HDMoviesChannel Streams Provider (hdmovieschannel.com)
 * DLE-style site: POST search with story=<query>&do=search&subaction=search
 * Movie page: /<id>-<slug>.html
 * Download links: HubCloud/gadgetsweb redirectors → resolver
 */

import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'HDMoviesChannel';
const BASE_URL = (process.env.HDMOVIESCHANNEL_BASE_URL || 'https://hdmovieschannel.com').replace(/\/+$/, '');
const REDIRECTOR_PATTERNS = ['gadgetsweb', 'hubcloud', 'hubdrive', 'hubcdn', 'hblinks', 'gdtot', 'fastream', 'modpro', 'leechpro', 'driveseed', 'driveleech'];
const searchCache = new Map(); const pageCache = new Map();
const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchHDMoviesChannel(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    try {
        // Try GET search first (DLE sites often support both GET and POST)
        const resp = await makeRequest(`${BASE_URL}/?s=${encodeURIComponent(query)}`, {
            parseHTML: true, timeout: 12000, maxRetries: 0,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (resp.statusCode !== 200) return [];
        return parseSearchResults(resp.document, resp.body);
    } catch { return []; }
}

function parseSearchResults($, body) {
    const results = [];
    if (!$) return results;
    $('a[href*="hdmovieschannel"]').each((_, el) => {
        const href = $(el).attr('href');
        const text = cleanText($(el).text());
        if (href && text.length > 5 && href.includes('.html') && !href.includes('/category/') && !href.includes('/page/')) {
            results.push({ title: text, url: href });
        }
    });
    return results;
}

export async function getHDMoviesChannelStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const isSeries = type === 'series' || type === 'tv';
        let bestMatch = null;
        for (const q of [meta.name, removeYear(meta.name), ...generateAlternativeQueries(meta.name, meta.original_title || '')].filter(Boolean)) {
            const results = await searchHDMoviesChannel(q);
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
            url: l.url, behaviorHints: { notWebReady: true, bingeGroup: `phoenix-hdmovieschannel-${l.quality}` }
        }));
        pageCache.set(bestMatch.url, { data: streams, ts: Date.now() });
        return streams;
    } catch { return []; }
}
