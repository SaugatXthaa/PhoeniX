/**
 * MoviesLeech HTTP Streams
 * Scrapes moviesleech.app posts -> leechpro.blog archive links -> driveseed/hubcloud
 * WordPress site with maxbutton download links pattern.
 */

import * as cheerio from 'cheerio';
import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { makeRequest } from '../../utils/http.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches,
    getResolutionFromName
} from '../../utils/parsing.js';
import { extractFileName } from '../../../common/torrent-utils.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import {
    parseSizeFromText,
    isLazyLoadEnabled,
    createPreviewStream,
    formatPreviewStreams
} from '../../utils/preview-mode.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import { fetchWithFlaresolverr } from '../../../util/flaresolverr-manager.js';

const BASE_URL = (process.env.MOVIESLEECH_BASE_URL || 'https://moviesleech.app').replace(/\/+$/, '');
const PROVIDER = 'MoviesLeech';
const MOVIESLEECH_FLARESOLVERR_ENABLED = process.env.MOVIESLEECH_FLARESOLVERR_ENABLED === 'true';

function isCloudflareChallenge(body = '', statusCode = null) {
    const lower = (body || '').toLowerCase();
    if (lower.includes('cf-mitigated') ||
        lower.includes('just a moment') ||
        lower.includes('cf_chl') ||
        lower.includes('challenge-platform') ||
        lower.includes('cf-turnstile') ||
        lower.includes('verify_turnstile') ||
        (lower.includes('security check') && lower.includes('cloudflare')) ||
        lower.includes('enable javascript and cookies to continue')) {
        return true;
    }
    if (statusCode === 403 || statusCode === 429) {
        return true;
    }
    return false;
}

const SEARCH_CACHE_TTL = parseInt(process.env.MOVIESLEECH_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000;
const PAGE_CACHE_TTL = parseInt(process.env.MOVIESLEECH_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000;

const searchCache = new Map();
const pageCache = new Map();

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
}

/**
 * Search MoviesLeech via WordPress ?s= query
 */
async function searchMoviesLeech(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        console.log(`[${PROVIDER}] Search cache hit for "${query}"`);
        return cached.data;
    }

    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    try {
        let response = await makeRequest(url, { parseHTML: true, timeout: 8000 });

        // If we got Cloudflare challenge, try FlareSolverr
        if (response.body && isCloudflareChallenge(response.body, response.statusCode)) {
            if (!MOVIESLEECH_FLARESOLVERR_ENABLED) {
                console.log(`[${PROVIDER}] Cloudflare detected for search, FlareSolverr is disabled`);
                return [];
            }
            console.log(`[${PROVIDER}] Cloudflare detected, using FlareSolverr for search...`);
            const flareResult = await fetchWithFlaresolverr(url, { timeout: 30000 });
            if (!flareResult?.body) {
                console.log(`[${PROVIDER}] FlareSolverr failed for search`);
                return [];
            }
            const $ = cheerio.load(flareResult.body);
            response = { body: flareResult.body, document: $ };
        }

        const $ = response.document;
        const results = [];

        $('article, .post-item, .result-item').each((_, el) => {
            const $el = $(el);
            const link = $el.find('a[href]').first().attr('href');
            const title = cleanText(
                $el.find('.title a, h2 a, h3 a').first().text() ||
                $el.find('a').first().attr('title') ||
                $el.find('a').first().text()
            );

            if (link && title && link.includes('moviesleech') && link.includes('download-')) {
                results.push({ title, url: link });
            }
        });

        // Fallback: regex for download page links
        if (results.length === 0) {
            const body = response.body || '';
            const regex = new RegExp(`https?://[^"'\\s]*moviesleech[^"'\\s]*/download-[^"'\\s]+`, 'gi');
            const seen = new Set();
            for (const match of body.matchAll(regex)) {
                const href = match[0].replace(/['"]+$/, '');
                if (seen.has(href)) continue;
                seen.add(href);
                const slug = href.split('/').filter(Boolean).pop() || '';
                const derived = cleanText(slug.replace(/^download-/, '').replace(/[-_]+/g, ' '));
                if (derived) {
                    results.push({ title: derived, url: href });
                }
            }
        }

        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        console.log(`[${PROVIDER}] Search "${query}" returned ${results.length} results`);
        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search failed for "${query}": ${err.message}`);
        return [];
    }
}

/**
 * Parse a MoviesLeech detail page for download links
 * Pattern: <h3> with quality info + <a class="maxbutton-1"> pointing to leechpro.blog archive URLs
 */
async function loadMoviesLeechPage(detailUrl) {
    const cached = pageCache.get(detailUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        console.log(`[${PROVIDER}] Page cache hit for ${detailUrl}`);
        return cached.data;
    }

    try {
        let response = await makeRequest(detailUrl, { parseHTML: true, timeout: 8000 });

        // If we got Cloudflare challenge, try FlareSolverr
        if (response.body && isCloudflareChallenge(response.body, response.statusCode)) {
            if (!MOVIESLEECH_FLARESOLVERR_ENABLED) {
                console.log(`[${PROVIDER}] Cloudflare detected on detail page, FlareSolverr is disabled`);
                return [];
            }
            console.log(`[${PROVIDER}] Cloudflare detected on detail page, using FlareSolverr...`);
            const flareResult = await fetchWithFlaresolverr(detailUrl, { timeout: 30000 });
            if (!flareResult?.body) {
                console.log(`[${PROVIDER}] FlareSolverr failed for detail page`);
                return [];
            }
            response = { body: flareResult.body, document: cheerio.load(flareResult.body) };
        }

        const $ = response.document;
        const entries = [];

        // Strategy 1: Parse h3 headings paired with maxbutton links
        const headings = $('h3, h4').toArray();
        for (const heading of headings) {
            const $heading = $(heading);
            const headingText = $heading.text().trim();

            if (!headingText.toLowerCase().includes('download')) continue;

            let $next = $heading.parent().next();
            if (!$next.find('a[class*="maxbutton"]').length) {
                $next = $heading.next();
            }

            const $link = $next.find('a[class*="maxbutton"]').first();
            if (!$link.length) continue;

            const href = $link.attr('href');
            if (!href) continue;

            const quality = headingText.match(/(480p|720p|1080p|2160p|4K)/i)?.[1] || '';
            const sizeMatch = headingText.match(/\[([^\]]*(?:MB|GB|TB)[^\]]*)\]/i);
            const size = sizeMatch ? sizeMatch[1].trim() : parseSizeFromText(headingText);
            const languages = detectLanguagesFromTitle(headingText);

            entries.push({
                url: href,
                quality: headingText,
                size,
                languages,
                resolution: quality
            });
        }

        // Strategy 2: Fallback - find all maxbutton links with archive URLs
        if (entries.length === 0) {
            $('a[class*="maxbutton"]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || (!href.includes('leechpro.blog') && !href.includes('/archives/'))) return;

                const $parent = $(el).closest('p, div');
                const $prevHeading = $parent.prevAll('h3, h4').first();
                const qualityText = $prevHeading.text().trim() || '';

                const quality = qualityText.match(/(480p|720p|1080p|2160p|4K)/i)?.[1] || '';
                const sizeMatch = qualityText.match(/\[([^\]]*(?:MB|GB|TB)[^\]]*)\]/i);
                const size = sizeMatch ? sizeMatch[1].trim() : parseSizeFromText(qualityText);

                entries.push({
                    url: href,
                    quality: qualityText || 'Download',
                    size,
                    languages: detectLanguagesFromTitle(qualityText),
                    resolution: quality
                });
            });
        }

        pageCache.set(detailUrl, { data: entries, ts: Date.now() });
        console.log(`[${PROVIDER}] Parsed ${entries.length} download entries from ${detailUrl}`);
        return entries;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to load page ${detailUrl}: ${err.message}`);
        return [];
    }
}

function buildStream(result, context) {
    if (!result?.url) return null;

    const labelBase = cleanText(result.title || result.name || context.quality || '');
    const size = result.size || context.size || parseSizeFromText(labelBase) || null;
    const qualityLabel = getResolutionFromName(labelBase || context.quality || '') || 'HTTP';
    const resLabel = qualityLabel === '2160p' ? '4k' : qualityLabel;
    const languages = Array.from(
        new Set([
            ...(context.languages || []),
            ...detectLanguagesFromTitle(labelBase),
            ...detectLanguagesFromTitle(context.quality || '')
        ].filter(Boolean))
    );
    const languageFlags = renderLanguageFlags(languages);
    const sizeInfo = size ? `\n💾 ${size} | ${PROVIDER}` : `\n${PROVIDER}`;
    const title = `${labelBase || context.quality || 'Download'}${languageFlags}${sizeInfo}`;
    const fileName = extractFileName(result.title || result.name || '');
    const behaviorHints = { bingeGroup: 'moviesleech-http' };
    if (fileName) behaviorHints.fileName = fileName;

    return {
        name: `PhoeniX\n${resLabel}`,
        title,
        url: encodeUrlForStreaming(result.url),
        size,
        resolution: resLabel,
        languages,
        behaviorHints,
        httpProvider: PROVIDER
    };
}

export async function getMoviesLeechStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        let meta = prefetchedMeta;
        if (!meta) {
            meta = await Cinemeta.getMeta(type, tmdbId);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...generateAlternativeQueries(meta.name, meta.original_title)
        ].filter(Boolean)));

        console.log(`[${PROVIDER}] Searching with ${queries.length} queries:`, queries);
        const searchPromises = queries.map(q => searchMoviesLeech(q).then(results => ({ query: q, results })));
        const searchResponses = await Promise.all(searchPromises);

        const searchResults = [];
        for (const { query, results } of searchResponses) {
            console.log(`[${PROVIDER}] Query "${query}" returned ${results.length} results`);
            searchResults.push(...results);
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results for ${meta.name}`);
            return [];
        }

        const best = getSortedMatches(searchResults, meta.name)[0];
        if (!best?.url) {
            console.log(`[${PROVIDER}] No suitable match for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected match: ${best.title} -> ${best.url}`);
        const downloadEntries = await loadMoviesLeechPage(best.url);
        if (downloadEntries.length === 0) {
            console.log(`[${PROVIDER}] No download entries found`);
            return [];
        }

        if (isLazyLoadEnabled()) {
            console.log(`[${PROVIDER}] Lazy-load: returning ${downloadEntries.length} preview streams`);

            const previewStreams = downloadEntries.map(entry => {
                const label = entry.quality || 'Download';
                const languages = entry.languages?.length
                    ? entry.languages
                    : detectLanguagesFromTitle(entry.quality || '');
                return createPreviewStream({
                    url: entry.url,
                    label,
                    provider: PROVIDER,
                    size: entry.size,
                    languages
                });
            });

            return formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);
        }

        const streamPromises = downloadEntries.map(async (entry) => {
            try {
                const extracted = await processExtractorLinkWithAwait(entry.url, 2);
                if (!extracted?.length) return [];
                return extracted.map(r => buildStream(r, entry)).filter(Boolean);
            } catch (err) {
                console.log(`[${PROVIDER}] Extraction failed for ${entry.url}: ${err.message}`);
                return [];
            }
        });

        const resolved = (await Promise.all(streamPromises)).flat().filter(Boolean);

        const seen = new Set();
        const streams = [];
        for (const stream of resolved) {
            if (!stream.url || seen.has(stream.url)) continue;
            seen.add(stream.url);
            streams.push(stream);
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
        return streams;
    } catch (err) {
        console.error(`[${PROVIDER}] Unexpected error: ${err.message}`);
        return [];
    }
}
