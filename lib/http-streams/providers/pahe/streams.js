/**
 * Pahe Streams Provider (pahe.ink)
 *
 * Pahe post pages contain quality sections like:
 *   <b>480p x264</b> | 750 MB<br />
 *   <a href="https://teknoasian.com/?ht=...">SD</a>   (1Fichier — "SD" = "StreamDive", legacy code)
 *   <a href="https://teknoasian.com/?ht=...">GD</a>   (Google Drive)
 *   <a href="https://teknoasian.com/?ht=...">MG</a>   (Mega)
 *   <a href="https://teknoasian.com/?ht=...">1D</a>   (1Download/1Fichier)
 *   <a href="https://teknoasian.com/?ht=...">PD</a>   (PixelDrain)
 *   <a href="https://teknoasian.com/?ht=...">1F</a>   (1Fichier)
 *
 * teknoasian.com is Cloudflare-protected (returns a JS auto-submit form → POST → CF challenge).
 * Server-side resolution is not possible without FlareSolverr, and even with FlareSolverr
 * the POST flow is fragile. We return the Pahe post page URL as `externalUrl` so the user
 * can open it in Nuvio's webview and click the download button for their preferred host.
 *
 * Size/quality parsing walks the DOM children in order, tracking the most recent
 * <b>QUALITY</b> | SIZE<br /> heading so each link gets the correct metadata (previously
 * all links inherited the first size found in the parent div).
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

// Pahe.ink blocks requests with minimal User-Agents — use a full browser UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

// Server codes used in the <a> text on Pahe post pages
const SERVER_NAMES = {
    'PD': 'PixelDrain', 'VF': 'Voe', 'GD': 'GDrive', 'MG': 'Mega',
    '1F': '1Fichier', '1D': '1Fichier', 'SD': 'StreamDive', 'GO': 'GDTot'
};

function cleanText(t = '') { return t.replace(/\s+/g, ' ').trim(); }

async function searchPahe(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) return cached.data;
    try {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        const response = await makeRequest(searchUrl, { parseHTML: true, timeout: 12000, maxRetries: 0, headers: REQUEST_HEADERS, disableProxy: true });
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

/**
 * Parse a Pahe post page to extract download links with correct quality/size.
 *
 * The page structure is:
 *   <div class="box download">
 *     <b>BluRay 480p x264</b> 500 MB<br />           (no pipe separator)
 *     <a href="...teknoasian.com/?ht=...">1F</a>
 *     <a href="...teknoasian.com/?ht=...">MG</a>
 *     ...
 *     <b>720p x264</b> | 1.46 GB<br />                (with pipe separator)
 *     <a href="...teknoasian.com/?ht=...">SD</a>
 *     ...
 *   </div>
 *
 * We parse the raw HTML of the download box with a regex to extract all
 * quality/size headings, then associate each link with the most recent heading.
 */
async function loadPahePost(postUrl, isSeries, season, episode) {
    const cached = pageCache.get(postUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) return cached.data;
    try {
        const response = await makeRequest(postUrl, { parseHTML: true, timeout: 15000, maxRetries: 0, headers: REQUEST_HEADERS, disableProxy: true });
        if (response.statusCode !== 200) return null;
        const $ = response.document;
        const pageTitle = $('h1.entry-title, h1.post-title, h1').first().text().trim();
        const pageLanguages = detectLanguagesFromTitle(pageTitle);

        const downloadLinks = [];

        // Strategy 1: Parse the raw HTML to find quality/size headings and associate
        // them with the teknoasian links that follow.
        //
        // Heading patterns (both with and without pipe separator):
        //   <b>BluRay 480p x264</b> 500 MB<br />
        //   <b>480p x264</b> | 750 MB<br />
        //   <b>1080p x264 DD5.1</b> 3.29 GB<br />
        const bodyHtml = response.body || '';

        // Extract all heading positions: { quality, size, position }
        // Matches both <b>...</b> and <strong>...</strong> tags, with or without pipe separator
        const headings = [];
        const headingRegex = /<(?:b|strong)>([^<]*(?:480p|720p|1080p|2160p|4k)[^<]*)<\/(?:b|strong)>\s*(?:\|\s*)?([\d.]+\s*(?:GB|MB|TB))\s*<br\s*\/?>/gi;
        let hMatch;
        while ((hMatch = headingRegex.exec(bodyHtml)) !== null) {
            const qualityText = hMatch[1];
            let quality = 'auto';
            if (/2160p|4k|uhd/i.test(qualityText)) quality = '2160p';
            else if (/1080p/i.test(qualityText)) quality = '1080p';
            else if (/720p/i.test(qualityText)) quality = '720p';
            else if (/480p/i.test(qualityText)) quality = '480p';
            const size = hMatch[2].replace(/\s+/g, ' ').trim();
            headings.push({ quality, size, position: hMatch.index, end: hMatch.index + hMatch[0].length });
        }

        // Extract all teknoasian link positions
        const linkRegex = /<a\s+href="(https?:\/\/teknoasian\.com\/[^"]+)"[^>]*>\s*([A-Za-z0-9]+)\s*<\/a>/gi;
        const links = [];
        let lMatch;
        while ((lMatch = linkRegex.exec(bodyHtml)) !== null) {
            links.push({
                url: lMatch[1],
                serverCode: lMatch[2].toUpperCase(),
                position: lMatch.index
            });
        }

        // Associate each link with the most recent heading before it
        for (const link of links) {
            let bestHeading = null;
            for (const h of headings) {
                if (h.position < link.position) {
                    bestHeading = h;
                } else {
                    break;
                }
            }

            let quality = bestHeading?.quality || 'auto';
            let size = bestHeading?.size || null;

            // Fallback: if no heading found, try to detect from the closest parent context
            if (quality === 'auto' || !size) {
                const $el = $(`a[href="${link.url}"]`).first();
                if ($el.length) {
                    const parent = $el.closest('div, p, li, td, tr').first();
                    const context = cleanText(parent.text());
                    if (quality === 'auto') {
                        if (/2160p|4k|uhd/i.test(context)) quality = '2160p';
                        else if (/1080p/i.test(context)) quality = '1080p';
                        else if (/720p/i.test(context)) quality = '720p';
                        else if (/480p/i.test(context)) quality = '480p';
                    }
                    if (!size) {
                        const sizeMatch = context.match(/([\d.]+)\s*(GB|MB|TB)/i);
                        if (sizeMatch) size = `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
                    }
                }
            }

            // Episode filtering for series
            if (isSeries && season && episode) {
                const $el = $(`a[href="${link.url}"]`).first();
                if ($el.length) {
                    const parent = $el.closest('div, p, li, td, tr').first();
                    const context = cleanText(parent.text());
                    const epMatch = context.match(/S0*(\d+)\s*E0*(\d+)/i);
                    if (epMatch) {
                        if (parseInt(epMatch[1]) !== parseInt(season) || parseInt(epMatch[2]) !== parseInt(episode)) continue;
                    }
                }
            }

            const serverName = SERVER_NAMES[link.serverCode] || link.serverCode;
            downloadLinks.push({
                url: link.url,
                server: serverName,
                serverCode: link.serverCode,
                quality,
                size,
                label: `Pahe [${serverName}]`,
                languages: pageLanguages
            });
        }

        pageCache.set(postUrl, { data: downloadLinks, ts: Date.now() });
        return downloadLinks;
    } catch { return null; }
}

export async function getPaheStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    // Pahe's download links go through teknoasian.com (CF-protected) → s0-greate.net
    // (obfuscated JS) which requires browser JS execution to resolve.
    // Server-side resolution is not possible.
    //
    // Returning externalUrl opens an external browser which the user doesn't want.
    // Returning [] means no Pahe streams appear, but avoids broken/error streams.
    //
    // Disabled until a server-side resolution method is found.
    return [];
}
