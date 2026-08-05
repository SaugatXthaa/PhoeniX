/**
 * CineDoze HTTP Streams
 * Scrapes cinedoze.tv posts -> cinedoze links -> savelinks pages, preferring hubdrive/hubcloud
 * with gdflix as a pixeldrain-only fallback.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { makeRequest } from '../../utils/http.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import { getResolutionFromName } from '../../utils/parsing.js';
import { extractFileName } from '../../../common/torrent-utils.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import {
    parseSizeFromText,
    isLazyLoadEnabled,
    createPreviewStream,
    formatPreviewStreams
} from '../../utils/preview-mode.js';
import * as config from '../../../config.js';

const BASE_URL = (process.env.CINEDOZE_BASE_URL || 'https://cinedoze.tv').replace(/\/+$/, '');
const PROVIDER = 'CineDoze';
const CINEDOZE_PROXY_URL = process.env.CINEDOZE_PROXY_URL
    || 'socks5h://100.109.163.45:1080';
const CINEDOZE_FLARESOLVERR_ENABLED = process.env.CINEDOZE_FLARESOLVERR_ENABLED === 'true';

// FlareSolverr configuration
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const FLARESOLVERR_V2 = config.FLARESOLVERR_V2 || process.env.FLARESOLVERR_V2 === 'true';
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || process.env.FLARESOLVERR_PROXY_URL || '';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.CINEDOZE_FLARESOLVERR_TIMEOUT, 10) || 45000;

function normalizeProxyUrl(url = '') {
    if (!url) return '';
    if (url.toLowerCase().startsWith('socks5://')) {
        return `socks5h://${url.slice('socks5://'.length)}`;
    }
    return url;
}

function createProxyAgent(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        const lower = proxyUrl.toLowerCase();
        if (lower.startsWith('socks4://') || lower.startsWith('socks5://') || lower.startsWith('socks5h://')) {
            return new SocksProxyAgent(proxyUrl);
        }
        if (lower.startsWith('http://') || lower.startsWith('https://')) {
            return new HttpsProxyAgent(proxyUrl);
        }
    } catch (error) {
        console.warn(`[${PROVIDER}] Failed to create proxy agent ${proxyUrl}: ${error.message}`);
    }
    return null;
}

const CINEDOZE_PROXY_AGENT = createProxyAgent(normalizeProxyUrl(CINEDOZE_PROXY_URL));

async function makeCineDozeRequest(url, options = {}) {
    const {
        parseHTML = false,
        timeout = 5000,
        headers = {},
        disableProxy = false
    } = options;

    if (!CINEDOZE_PROXY_AGENT || disableProxy) {
        return makeRequest(url, options);
    }

    const response = await axios.get(url, {
        timeout,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ...headers
        },
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [data => data],
        httpAgent: CINEDOZE_PROXY_AGENT,
        httpsAgent: CINEDOZE_PROXY_AGENT,
        proxy: false
    });

    const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    return {
        statusCode: response.status,
        headers: response.headers || {},
        body,
        document: parseHTML ? cheerio.load(body) : null,
        url: response.request?.res?.responseUrl || url
    };
}

/**
 * Check if a response body contains a Cloudflare challenge
 */
function isCloudflareChallenge(body = '', statusCode = null) {
    const lower = (body || '').toLowerCase();

    const strongSignals = [
        lower.includes('cf-mitigated'),
        lower.includes('just a moment'),
        lower.includes('checking your browser'),
        lower.includes('attention required! | cloudflare'),
        lower.includes('cf-turnstile'),
        lower.includes('verify_turnstile'),
        lower.includes('enable javascript and cookies to continue')
    ];
    if (strongSignals.some(Boolean)) {
        return true;
    }

    // Soft markers can appear on real pages; require multiple markers (or 403/429) to classify as challenge.
    const softSignals = {
        cfChl: lower.includes('cf_chl'),
        challengePlatform: lower.includes('challenge-platform') || lower.includes('/cdn-cgi/challenge-platform'),
        cfBrowserVerification: lower.includes('cf-browser-verification'),
        securityCheck: lower.includes('security check') && lower.includes('cloudflare')
    };
    const softCount = Object.values(softSignals).filter(Boolean).length;

    if (softCount >= 2) {
        return true;
    }

    if ((statusCode === 403 || statusCode === 429) && softCount > 0) {
        return true;
    }

    return false;
}

function shouldUseFlareProxy(url) {
    if (!FLARESOLVERR_PROXY_URL || !url) return false;
    const lower = url.toLowerCase();
    if (lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('hubcdn')) return false;
    return true;
}

function getCloudflareMarkers(body = '') {
    const lower = (body || '').toLowerCase();
    const markers = [];
    if (lower.includes('cf-mitigated')) markers.push('cf-mitigated');
    if (lower.includes('just a moment')) markers.push('just-a-moment');
    if (lower.includes('cf_chl')) markers.push('cf_chl');
    if (lower.includes('challenge-platform')) markers.push('challenge-platform');
    if (lower.includes('cf-turnstile')) markers.push('cf-turnstile');
    if (lower.includes('verify_turnstile')) markers.push('verify_turnstile');
    if (lower.includes('security check')) markers.push('security-check');
    if (lower.includes('cloudflare')) markers.push('cloudflare');
    return markers;
}

/**
 * Fetch a URL using FlareSolverr to bypass Cloudflare
 */
async function fetchWithFlareSolverr(url, headers = {}) {
    console.log(`[${PROVIDER}] fetchWithFlareSolverr called for ${url}`);

    if (!CINEDOZE_FLARESOLVERR_ENABLED) {
        console.log(`[${PROVIDER}] FlareSolverr is disabled for this provider`);
        return null;
    }

    if (!FLARESOLVERR_URL) {
        console.log(`[${PROVIDER}] FLARESOLVERR_URL not configured, returning null`);
        return null;
    }

    console.log(`[${PROVIDER}] Using FlareSolverr to bypass Cloudflare for ${url}`);
    const flareTimeout = Math.max(FLARESOLVERR_TIMEOUT, 30000);

    try {
        const requestBody = {
            cmd: 'request.get',
            url,
            maxTimeout: flareTimeout
        };

        if (shouldUseFlareProxy(url)) {
            requestBody.proxy = { url: FLARESOLVERR_PROXY_URL };
        }

        console.log(`[${PROVIDER}] FlareSolverr POST to ${FLARESOLVERR_URL}/v1 with timeout ${flareTimeout + 5000}ms, proxy: ${shouldUseFlareProxy(url) ? 'yes' : 'no'}`);
        let response;
        try {
            response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
                timeout: flareTimeout + 5000,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (axiosErr) {
            console.error(`[${PROVIDER}] Axios error: ${axiosErr.message}`);
            throw axiosErr;
        }

        console.log(`[${PROVIDER}] FlareSolverr response status: ${response.status}`);
        const solution = response?.data?.solution;
        if (!solution) {
            console.log(`[${PROVIDER}] FlareSolverr returned no solution in response for ${url}`);
            return null;
        }

        if (!solution?.response) {
            console.log(`[${PROVIDER}] FlareSolverr returned solution but no response body for ${url}`);
            return null;
        }

        const body = solution.response;
        const lower = String(body).toLowerCase();

        if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('cf-browser-verification')) {
            console.log(`[${PROVIDER}] FlareSolverr still blocked for ${url}`);
            return null;
        }

        console.log(`[${PROVIDER}] FlareSolverr success for ${url}, got ${body.length} bytes`);
        return {
            document: cheerio.load(body),
            body,
            url: solution.url || url,
            statusCode: solution.status
        };
    } catch (error) {
        console.error(`[${PROVIDER}] FlareSolverr error for ${url}: ${error.message}`);
        if (error.response?.data) {
            console.error(`[${PROVIDER}] FlareSolverr response:`, JSON.stringify(error.response.data).substring(0, 200));
        }
        return null;
    }
}

// Cache configuration
const SEARCH_CACHE_TTL = parseInt(process.env.CINEDOZE_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000; // 30 minutes
const PAGE_CACHE_TTL = parseInt(process.env.CINEDOZE_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes

// In-memory cache only
const searchCache = new Map();
const pageCache = new Map();
const expandCache = new Map();

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
}

function toAbsolute(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

async function searchCineDoze(query) {
    // CineDoze search breaks when query contains colons - strip them
    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();

    // Check in-memory cache first
    const cacheKey = cleanQuery.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        console.log(`[${PROVIDER}] Search cache hit (memory) for "${query}"`);
        return cached.data;
    }

    const url = `${BASE_URL}/search/${encodeURIComponent(cleanQuery)}/`;
    try {
        let response = await makeCineDozeRequest(url, { parseHTML: true, timeout: 8000 });
        let $ = response.document;
        let body = response.body || '';

        // Check if we're blocked by Cloudflare
        if (!$ || isCloudflareChallenge(body, response.statusCode)) {
            console.log(`[${PROVIDER}] Cloudflare challenge detected for search "${query}", using FlareSolverr...`);
            const flareResponse = await fetchWithFlareSolverr(url);

            if (flareResponse && flareResponse.document) {
                $ = flareResponse.document;
                body = flareResponse.body || '';
                console.log(`[${PROVIDER}] FlareSolverr bypass successful for search "${query}"`);
            } else {
                console.log(`[${PROVIDER}] FlareSolverr bypass failed for search "${query}"`);
                return [];
            }
        }

        const results = [];

        $('article').each((_, article) => {
            const link =
                $(article).find('a[href*="/movies/"], a[href*="/tvshows/"]').first().attr('href');
            const title =
                cleanText(
                    $(article).find('.title').text() ||
                    $(article).find('h3').text() ||
                    $(article).find('h2').text()
                );
            const absolute = toAbsolute(link, url);
            if (absolute && title) {
                results.push({ title, url: absolute });
            }
        });

        // Fallback: regex for movie/tvshow links if DOM parsing failed
        if (results.length === 0) {
            const regex = /https?:\/\/cinedoze\.tv\/(?:movies|tvshows)\/[^\s"'<>]+/gi;
            const matches = [...(body || '').matchAll(regex)].map(m => m[0]);
            for (const href of matches) {
                const absolute = toAbsolute(href, url);
                if (!absolute) continue;
                // Derive title from slug
                const slug = absolute.split('/').filter(Boolean).pop() || '';
                const derived = cleanText(slug.replace(/[-_]+/g, ' '));
                if (derived) {
                    results.push({ title: derived, url: absolute });
                }
            }
        }

        // Cache the results in memory
        searchCache.set(cacheKey, { data: results, ts: Date.now() });

        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search failed for "${query}": ${err.message}`);
        return [];
    }
}

async function loadCineDozePage(detailUrl) {
    // Check in-memory cache first
    const cached = pageCache.get(detailUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        console.log(`[${PROVIDER}] Page cache hit (memory) for ${detailUrl}`);
        return cached.data;
    }

    try {
        let response = await makeCineDozeRequest(detailUrl, { parseHTML: true, timeout: 8000 });
        let $ = response.document;
        let body = response.body || '';

        // Check if we're blocked by Cloudflare
        if (!$ || isCloudflareChallenge(body, response.statusCode)) {
            console.log(`[${PROVIDER}] Cloudflare challenge detected for detail page, using FlareSolverr...`);
            const flareResponse = await fetchWithFlareSolverr(detailUrl);

            if (flareResponse && flareResponse.document) {
                $ = flareResponse.document;
                body = flareResponse.body || '';
                console.log(`[${PROVIDER}] FlareSolverr bypass successful for detail page`);
            } else {
                console.log(`[${PROVIDER}] FlareSolverr bypass failed for detail page`);
                return [];
            }
        }

        const rows = $('#download table tbody tr');
        const entries = [];

        rows.each((_, row) => {
            const link = $(row).find('a[href]').attr('href');
            const quality = cleanText($(row).find('.quality').text() || $(row).find('td').eq(1).text());
            const languageText = cleanText($(row).find('td').eq(2).text());
            const sizeText = cleanText($(row).find('td').eq(3).text());

            const absolute = toAbsolute(link, detailUrl);
            if (!absolute) return;

            entries.push({
                url: absolute,
                quality: quality || 'Download',
                languages: detectLanguagesFromTitle(languageText),
                size: sizeText || parseSizeFromText(quality)
            });
        });

        // Cache the result in memory
        pageCache.set(detailUrl, { data: entries, ts: Date.now() });

        return entries;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to load detail page ${detailUrl}: ${err.message}`);
        return [];
    }
}

function extractHostLinks(html, baseUrl) {
    const hostLinks = [];
    const regex = /https?:\/\/[^\s"'<>]+/gi;
    const matches = [...(html || '').matchAll(regex)];
    const seen = new Set();

    for (const m of matches) {
        const href = toAbsolute(m[0], baseUrl);
        if (!href || seen.has(href)) continue;
        const lower = href.toLowerCase();
        if (
            lower.includes('hubdrive') ||
            lower.includes('hubcloud') ||
            lower.includes('hubcdn') ||
            lower.includes('gdflix') ||
            lower.includes('filepress') ||
            lower.includes('pixeldrain') ||
            lower.includes('filesdl')
        ) {
            hostLinks.push(href);
            seen.add(href);
        }
    }

    return hostLinks;
}

async function expandCineDozeLink(linkUrl) {
    // Check in-memory cache first
    const cached = expandCache.get(linkUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        return cached.data;
    }

    try {
        const response = await makeCineDozeRequest(linkUrl, { parseHTML: false, timeout: 8000 });
        const finalUrl = response.url || linkUrl;
        const result = extractHostLinks(response.body, finalUrl);
        // Cache the result in memory
        expandCache.set(linkUrl, { data: result, ts: Date.now() });
        return result;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to expand cinedoze link ${linkUrl}: ${err.message}`);
        return [];
    }
}

/**
 * Quick metadata fetch from HubCloud page - extracts filename from page title
 * The HubCloud page title contains the full filename like:
 * "CineDoze.TV-Wicked For Good (2025) MLSBD.Co-Dual Audio [Hindi ORG-English] Amazon 4K.mkv"
 * Used in lazy-load mode to get proper filenames for preview streams
 */
async function fetchHubCloudMetadata(hubcloudUrl) {
    try {
        let response = await makeRequest(hubcloudUrl, { parseHTML: true, timeout: 2000, disableProxy: true });
        let $ = response.document;
        let body = response.body || '';

        // Check if we're blocked by Cloudflare
        if (!$ || isCloudflareChallenge(body, response.statusCode)) {
            const markers = getCloudflareMarkers(body);
            console.error(`[${PROVIDER}] Using FlareSolverr reason=challenge-detected status=${response.statusCode || 'n/a'} markers=${markers.join('|') || 'none'} url=${hubcloudUrl}`);
            const flareResponse = await fetchWithFlareSolverr(hubcloudUrl, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            });

            if (flareResponse && flareResponse.document) {
                $ = flareResponse.document;
                body = flareResponse.body || '';
                console.log(`[${PROVIDER}] FlareSolverr bypass successful for ${hubcloudUrl}`);
            } else {
                console.log(`[${PROVIDER}] FlareSolverr bypass failed for ${hubcloudUrl}`);
                return null;
            }
        }

        if (!$) return null;

        // The filename is in the page title on HubCloud pages
        const pageTitle = $('title').text().trim();

        // Check if we still got a Cloudflare page
        if (pageTitle.toLowerCase().includes('just a moment')) {
            console.log(`[${PROVIDER}] Page still shows Cloudflare challenge for ${hubcloudUrl}`);
            return null;
        }

        // Check if it looks like a video filename (ends with .mkv, .mp4, etc.)
        let filename = null;
        if (pageTitle && /\.(mkv|mp4|avi|webm|mov|m4v)$/i.test(pageTitle)) {
            filename = pageTitle;
            console.log(`[${PROVIDER}] Extracted filename from HubCloud title: ${filename}`);
        } else {
            // Fallback: look in body for filename patterns
            const fnMatch = body.match(/([A-Za-z0-9._\-\[\]()@ ]+\.(?:mkv|mp4|avi|webm))/i);
            if (fnMatch) {
                filename = fnMatch[1];
                console.log(`[${PROVIDER}] Extracted filename from body: ${filename}`);
            }
        }

        // Extract quality from filename
        const quality = (filename || '').match(/(2160p|1080p|720p|480p|4K)/i)?.[1] || null;

        return { filename, quality };
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to fetch HubCloud metadata from ${hubcloudUrl}: ${err.message}`);
        return null;
    }
}

function buildStream(result, context) {
    if (!result?.url) return null;

    const labelBase = cleanText(result.title || result.name || context.quality || '');
    const size = result.size || context.size || parseSizeFromText(labelBase) || parseSizeFromText(context.quality) || null;
    const qualityLabel = getResolutionFromName(labelBase || result.name || context.quality || '') || 'HTTP';
    const resLabel = qualityLabel === '2160p' ? '4k' : qualityLabel;
    const languages = Array.from(
        new Set([
            ...(context.languages || []),
            ...detectLanguagesFromTitle(labelBase),
            ...detectLanguagesFromTitle(context.quality || ''),
            ...detectLanguagesFromTitle(result.title || '')
        ].filter(Boolean))
    );
    const languageFlags = renderLanguageFlags(languages);
    const sizeInfo = size ? `\n💾 ${size} | ${PROVIDER}` : `\n${PROVIDER}`;
    const title = `${labelBase || context.quality || 'Download'}${languageFlags}${sizeInfo}`;
    const fileName = extractFileName(result.title || result.name || '');
    const behaviorHints = {
        bingeGroup: 'cinedoze-http'
    };
    if (fileName) {
        behaviorHints.fileName = fileName;
    }

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

function filterPixeldrainOnly(results) {
    return (results || []).filter(r => r.url && r.url.toLowerCase().includes('pixel'));
}

async function resolveHostLinks(hostLinks, context) {
    const hubLinks = hostLinks.filter(h => /hubdrive|hubcloud|hubcdn/.test(h));
    const gdflixLinks = hostLinks.filter(h => /gdflix/.test(h));

    // 1) Try hubdrive/hubcloud first
    for (const link of hubLinks) {
        try {
            const extracted = await processExtractorLinkWithAwait(link, 1);
            if (extracted && extracted.length > 0) {
                const streams = extracted.map(r => buildStream(r, context)).filter(Boolean);
                if (streams.length > 0) return streams;
            }
        } catch (err) {
            console.log(`[${PROVIDER}] Hub link failed ${link}: ${err.message}`);
        }
    }

    // 2) Fallback to gdflix -> only pixeldrain results
    for (const link of gdflixLinks) {
        try {
            const extracted = await processExtractorLinkWithAwait(link, 2);
            const pixelOnly = filterPixeldrainOnly(extracted);
            if (pixelOnly && pixelOnly.length > 0) {
                const streams = pixelOnly.map(r => buildStream(r, context)).filter(Boolean);
                if (streams.length > 0) return streams;
            }
        } catch (err) {
            console.log(`[${PROVIDER}] GDFlix fallback failed ${link}: ${err.message}`);
        }
    }

    return [];
}

export async function getCineDozeStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        // Use pre-fetched metadata if available, otherwise fetch it (fallback for direct calls)
        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] No pre-fetched metadata, fetching from Cinemeta...`);
            meta = await Cinemeta.getMeta(type, tmdbId);
        } else {
            console.log(`[${PROVIDER}] Using pre-fetched Cinemeta metadata: "${meta.name}"`);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...(meta.alternativeTitles || []),
            ...generateAlternativeQueries(meta.name, meta.original_title)
        ].filter(Boolean)));

        // Run searches in parallel for speed
        console.log(`[${PROVIDER}] Searching with ${queries.length} queries in parallel:`, queries);
        const searchPromises = queries.map(query => searchCineDoze(query).then(results => ({ query, results })));
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

        console.log(`[${PROVIDER}] Total ${searchResults.length} results before dedup/scoring`);
        const best = getSortedMatches(searchResults, meta.name)[0];
        if (!best?.url) {
            console.log(`[${PROVIDER}] No suitable match for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected match: ${best.title} -> ${best.url}`);
        const downloadEntries = await loadCineDozePage(best.url);
        if (downloadEntries.length === 0) {
            console.log(`[${PROVIDER}] No download entries found`);
            return [];
        }

        // Check if lazy-load mode is enabled (default: true for faster initial response)
        const useLazyLoad = isLazyLoadEnabled();

        if (useLazyLoad) {
            // Lazy-load mode: return preview streams without HubCloud extraction
            console.log(`[${PROVIDER}] Lazy-load: returning ${downloadEntries.length} preview streams without extraction`);

            const movieName = meta.name || 'Unknown';
            const movieYear = meta.year || '';

            const previewStreams = downloadEntries.map(entry => {
                const label = `${movieName}${movieYear ? ` (${movieYear})` : ''} - ${entry.quality || 'Download'}`;
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

            const streams = formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);
            console.log(`[${PROVIDER}] Lazy-load: returning ${streams.length} preview streams`);
            return streams;
        }

        // Full extraction mode (when lazy-load is disabled)
        const streamPromises = downloadEntries.map(async (entry) => {
            const hostLinks = await expandCineDozeLink(entry.url);
            if (!hostLinks.length) return [];
            return resolveHostLinks(hostLinks, entry);
        });

        const resolved = (await Promise.all(streamPromises)).flat().filter(Boolean);

        // Deduplicate by URL
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
