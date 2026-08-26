/**
 * DDLBase Streams Provider (ddlbase.com)
 * WordPress DDL behind Cloudflare — uses FlareSolverr
 */
import Cinemeta from '../../../util/cinemeta.js';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { fetchWithFlaresolverr } from '../../../util/flaresolverr-manager.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';

const PROVIDER = 'DDLBase';
const BASE_URL = (process.env.DDLBASE_BASE_URL || 'https://ddlbase.com').replace(/\/+$/, '');
const REDIRECTOR_PATTERNS = ['gadgetsweb', 'hubcloud', 'hubdrive', 'hubcdn', 'hblinks', 'gdtot', 'fastream', 'modpro', 'leechpro', 'driveseed', 'driveleech'];
const searchCache = new Map(); const pageCache = new Map();
const TTL = 30 * 60 * 1000;

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }
function isCF(body, status) { return (body || '').toLowerCase().includes('just a moment') || (body || '').toLowerCase().includes('cf-mitigated') || status === 403; }

async function searchDDLBase(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < TTL) return cached.data;
    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    try {
        let resp = await makeRequest(url, { parseHTML: true, timeout: 10000, maxRetries: 0 });
        let $ = resp.document; let body = resp.body || '';
        if ((!$ || isCF(body, resp.statusCode)) && process.env.FLARESOLVERR_URL) {
            const fr = await fetchWithFlaresolverr(url); if (fr?.body) { body = fr.body; $ = cheerio.load(body); }
        }
        if (!$) return [];
        const results = [];
        $('article, .post, .post-item').each((_, el) => {
            const $el = $(el); const link = $el.find('a[href]').first();
            const href = link.attr('href'); const title = cleanText($el.find('h2 a, h3 a, .entry-title a').first().text() || link.text());
            if (href && title && href.includes('ddlbase')) results.push({ title, url: href });
        });
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

export async function getDDLBaseStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const isSeries = type === 'series' || type === 'tv';
        let bestMatch = null;
        for (const q of [meta.name, removeYear(meta.name), ...generateAlternativeQueries(meta.name, meta.original_title || '')].filter(Boolean)) {
            const results = await searchDDLBase(q);
            if (results.length > 0) { const sorted = getSortedMatches(results, meta.name, { minScore: 20 }); bestMatch = sorted[0] || results[0]; if (bestMatch) break; }
        }
        if (!bestMatch) return [];
        const postUrl = bestMatch.url;
        let resp = await makeRequest(postUrl, { parseHTML: true, timeout: 12000, maxRetries: 0 });
        let $ = resp.document; let body = resp.body || '';
        if ((!$ || isCF(body, resp.statusCode)) && process.env.FLARESOLVERR_URL) {
            const fr = await fetchWithFlaresolverr(postUrl); if (fr?.body) { body = fr.body; $ = cheerio.load(body); }
        }
        if (!$) return [];
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
        return links.map(l => ({
            name: `PhoeniX\n${l.quality === '2160p' ? '4k' : l.quality}`,
            title: `${bestMatch.title} ${l.label}\n${renderLanguageFlags(l.languages || [])} ${l.size ? '💾 ' + l.size : ''} | ${PROVIDER}`.trim(),
            url: l.url, behaviorHints: { notWebReady: true, bingeGroup: `phoenix-ddlbase-${l.quality}` }
        }));
    } catch { return []; }
}
