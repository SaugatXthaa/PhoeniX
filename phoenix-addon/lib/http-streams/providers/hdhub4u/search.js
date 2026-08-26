/**
 * HDHub4u Search Helpers
 * Handles sitemap indexing and page parsing for download links
 */

import Fuse from 'fuse.js';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';
import { detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { getResolutionFromName } from '../../utils/parsing.js';
import * as config from '../../../config.js';
import flaresolverrManager from '../../../util/flaresolverr-manager.js';

// FlareSolverr configuration
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || process.env.FLARESOLVERR_PROXY_URL || '';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.HDHUB4U_FLARESOLVERR_TIMEOUT, 10) || 45000;

/**
 * Check if a response body contains a Cloudflare challenge
 */
function isCloudflareChallenge(body = '', statusCode = null) {
    const lower = (body || '').toLowerCase();
    return lower.includes('cf-mitigated') ||
        lower.includes('just a moment') ||
        lower.includes('cf_chl') ||
        (lower.includes('challenge-platform') && lower.includes('cf_chl')) ||
        lower.includes('cf-turnstile') ||
        lower.includes('verify_turnstile') ||
        (lower.includes('security check') && lower.includes('cloudflare'));
}

/**
 * Fetch a URL using FlareSolverr to bypass Cloudflare
 */
async function fetchWithFlareSolverr(url) {
    if (!FLARESOLVERR_URL) {
        return null;
    }

    if (!flaresolverrManager.isAvailable()) {
        const status = flaresolverrManager.getStatus();
        console.warn(`[HDHub4u/Search] FlareSolverr unavailable: circuit=${status.circuitOpen}, queue=${status.queueDepth}`);
        return null;
    }

    const slot = await flaresolverrManager.acquireSlot(30000);
    if (!slot.acquired) {
        console.warn(`[HDHub4u/Search] Could not acquire FlareSolverr slot: ${slot.reason}`);
        return null;
    }

    console.log(`[HDHub4u/Search] Using FlareSolverr for ${url}`);
    const flareTimeout = Math.max(FLARESOLVERR_TIMEOUT, 30000);

    try {
        const requestBody = {
            cmd: 'request.get',
            url,
            maxTimeout: flareTimeout
        };

        if (FLARESOLVERR_PROXY_URL) {
            requestBody.proxy = { url: FLARESOLVERR_PROXY_URL };
        }

        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        const solution = response?.data?.solution;
        if (!solution?.response) {
            console.log(`[HDHub4u/Search] FlareSolverr returned no response for ${url}`);
            return null;
        }

        const body = solution.response;
        const lower = String(body).toLowerCase();

        if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('cf-browser-verification')) {
            console.log(`[HDHub4u/Search] FlareSolverr still blocked for ${url}`);
            return null;
        }

        console.log(`[HDHub4u/Search] FlareSolverr success for ${url}`);
        return {
            body,
            url: solution.url || url,
            statusCode: solution.status
        };
    } catch (error) {
        console.log(`[HDHub4u/Search] FlareSolverr error for ${url}: ${error.message}`);
        if (error.message.includes('timeout') || error.code === 'ECONNABORTED') {
            flaresolverrManager.reportTimeout();
        } else {
            flaresolverrManager.reportFailure();
        }
        return null;
    } finally {
        slot.release();
    }
}

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

const DEFAULT_BASE_URLS = [
    'https://new5.hdhub4u.fo',
    'https://hdhub4u.fo',
    'https://new4.hdhub4u.fo',
    'https://new2.hdhub4u.fo',
    'https://hdhub4u.rehab',
    'https://new1.hdhub4u.fo'
].map(normalizeBaseUrl);

const ENV_BASE_URLS = (process.env.HDHUB4U_BASE_URLS || process.env.HDHUB4U_BASE_URL || '')
    .split(',')
    .map(normalizeBaseUrl)
    .filter(Boolean);

// Mutable state for discovered domains
let discoveredBaseUrl = null;
let discoveryPromise = null;
let discoveryTimestamp = 0;
const DISCOVERY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Discover the current working domain by following redirects
 * This handles HDHub4u's frequent domain changes
 */
async function discoverWorkingDomain() {
    const now = Date.now();
    if (discoveredBaseUrl && now - discoveryTimestamp < DISCOVERY_CACHE_TTL) {
        return discoveredBaseUrl;
    }

    if (discoveryPromise) {
        return discoveryPromise;
    }

    discoveryPromise = (async () => {
        const candidateUrls = ENV_BASE_URLS.length > 0 ? ENV_BASE_URLS : DEFAULT_BASE_URLS;

        for (const baseUrl of candidateUrls) {
            try {
                console.log(`[HDHub4u] Checking domain: ${baseUrl}`);
                const sitemapUrl = `${baseUrl}/sitemap.xml`;
                let response;
                try {
                    response = await makeRequest(sitemapUrl, {
                        maxRetries: 0,
                        timeout: 10000
                    });
                } catch (err) {
                    // makeRequest may throw on non-2xx; treat as needing FlareSolverr
                    response = { body: '', statusCode: 403 };
                }

                // If Cloudflare-blocked, try FlareSolverr
                if (!response.body || isCloudflareChallenge(response.body, response.statusCode)) {
                    console.log(`[HDHub4u] Domain ${baseUrl} blocked by Cloudflare, trying FlareSolverr`);
                    const flareResponse = await fetchWithFlareSolverr(sitemapUrl);
                    if (flareResponse && flareResponse.body) {
                        // Check for sitemap content (XML or HTML-rendered)
                        // Must contain actual sitemap data, not just the word in a Chrome error page
                        const hasSitemap = flareResponse.body.includes('post-sitemap') ||
                            (flareResponse.body.includes('<sitemapindex') && flareResponse.body.includes('<loc>'));
                        if (hasSitemap) {
                            const finalUrl = flareResponse.url || sitemapUrl;
                            const urlObj = new URL(finalUrl);
                            const finalBaseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
                            console.log(`[HDHub4u] Discovered working domain via FlareSolverr: ${finalBaseUrl} (from ${baseUrl})`);
                            discoveredBaseUrl = normalizeBaseUrl(finalBaseUrl);
                            discoveryTimestamp = Date.now();
                            return discoveredBaseUrl;
                        }
                    }
                    continue;
                }

                // Extract the actual domain from the response URL (after redirects)
                const finalUrl = response.url || sitemapUrl;
                const urlObj = new URL(finalUrl);
                const finalBaseUrl = `${urlObj.protocol}//${urlObj.hostname}`;

                // Verify we got a valid sitemap
                if (response.body && response.body.includes('sitemap')) {
                    console.log(`[HDHub4u] Discovered working domain: ${finalBaseUrl} (from ${baseUrl})`);
                    discoveredBaseUrl = normalizeBaseUrl(finalBaseUrl);
                    discoveryTimestamp = Date.now();
                    return discoveredBaseUrl;
                }
            } catch (err) {
                console.log(`[HDHub4u] Domain ${baseUrl} failed: ${err.message}`);
            }
        }

        // Fall back to first default if nothing works
        console.log('[HDHub4u] All domains failed, using first default');
        discoveredBaseUrl = DEFAULT_BASE_URLS[0];
        discoveryTimestamp = Date.now();
        return discoveredBaseUrl;
    })();

    try {
        return await discoveryPromise;
    } finally {
        discoveryPromise = null;
    }
}

/**
 * Get the list of base URLs, including dynamically discovered ones
 */
function getBaseUrls() {
    const urls = ENV_BASE_URLS.length > 0 ? [...ENV_BASE_URLS] : [...DEFAULT_BASE_URLS];
    if (discoveredBaseUrl && !urls.includes(discoveredBaseUrl)) {
        urls.unshift(discoveredBaseUrl);
    }
    return urls;
}

/**
 * Get the list of base hostnames for filtering
 */
function getBaseHosts() {
    return getBaseUrls()
        .map(base => {
            try {
                return new URL(base).hostname.toLowerCase();
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

// For backwards compatibility - these will be updated dynamically
const BASE_URLS = ENV_BASE_URLS.length > 0 ? ENV_BASE_URLS : DEFAULT_BASE_URLS;
const BASE_HOSTS = getBaseHosts();
const SITEMAP_CACHE_TTL = parseInt(process.env.HDHUB4U_SITEMAP_CACHE_TTL, 10) || 6 * 60 * 60 * 1000; // 6 hours
const PAGE_CACHE_TTL = parseInt(process.env.HDHUB4U_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes

// Only include direct file hosting links where we can extract filename and size
// These "drive" links show the actual file information on their page
const HOST_PATTERNS = [
    'hubdrive',
    'hubcloud',
    'hubcdn'
];

// These patterns are excluded - they're redirect services without file info
// and often lead to packs/zips or unreliable sources
// NOTE: 'gadgetsweb' is REMOVED from this list because series pages on HDHub4u
// use gadgetsweb.xyz/?id=<base64> links for individual episodes. The resolver
// (resolveHttpStreamUrl) handles these via getRedirectLinks().
const EXCLUDED_PATTERNS = [
    'gamerxyt',
    'hblinks',
    '4khdhub',
    'linksly',
    'shareus',
    'dood',
    'desiupload',
    'megaup',
    'filepress',
    'mediashore',
    'ninjastream',
    'hubstream',
    'hdstream4u',
    'pixeldrain',
    'workers.dev',
    'r2.dev',
    'googleusercontent'
];

const sitemapCache = {
    fetchedAt: 0,
    entries: []
};

const pageCache = new Map(); // url -> { fetchedAt, data }

let fuseIndex = null;
let fuseBuiltAt = 0;
let buildingFusePromise = null;

function normalizeSlug(url) {
    try {
        const { pathname } = new URL(url);
        const slug = pathname.replace(/\/+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
        return cleanTitle(slug);
    } catch {
        return cleanTitle(url);
    }
}

/**
 * Extract URLs from HTML-rendered sitemap (FlareSolverr renders XML as HTML)
 * @param {string} html - HTML body from FlareSolverr
 * @param {string} filter - Optional filter string to match in URLs (e.g., 'post-sitemap')
 * @returns {string[]} Array of extracted URLs
 */
function extractSitemapUrlsFromHtml(html, filter = null) {
    const urls = [];
    const seen = new Set();
    // Match href attributes containing sitemap or post URLs
    const hrefPattern = /href="(https?:\/\/[^"]+)"/g;
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
        const url = match[1];
        if (seen.has(url)) continue;
        if (filter && !url.includes(filter)) continue;
        // Skip non-content URLs
        if (url.includes('sitemaps.org') || url.includes('auctollo.com') || url.includes('wordpress.org')) continue;
        seen.add(url);
        urls.push(url);
    }
    return urls;
}

/**
 * Extract post entries from HTML-rendered sitemap page
 * @param {string} html - HTML body from FlareSolverr
 * @param {string} baseHostname - The hostname to filter URLs for
 * @returns {Array<{url: string, slug: string, lastmod: string|null}>}
 */
function extractSitemapEntriesFromHtml(html, baseHostname = null) {
    const entries = [];
    const seen = new Set();
    const hrefPattern = /href="(https?:\/\/[^"]+\/[^"]+\/)"/g;
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
        const url = match[1];
        if (seen.has(url)) continue;
        // Skip sitemaps, categories, and system URLs
        if (url.includes('sitemap') || url.includes('/category/') || url.includes('/tag/') ||
            url.includes('/author/') || url.includes('/page/') || url.includes('sitemaps.org') ||
            url.includes('auctollo.com') || url.includes('wordpress.org')) continue;
        // If we know the hostname, only include matching URLs
        if (baseHostname) {
            try {
                const urlHost = new URL(url).hostname;
                if (!urlHost.includes(baseHostname)) continue;
            } catch { continue; }
        }
        seen.add(url);
        entries.push({
            url,
            slug: normalizeSlug(url),
            lastmod: null
        });
    }
    return entries;
}

async function fetchSitemapList() {
    const now = Date.now();
    if (sitemapCache.entries.length > 0 && now - sitemapCache.fetchedAt < SITEMAP_CACHE_TTL) {
        return sitemapCache.entries;
    }

    try {
        // Discover working domain first (handles domain changes via redirects)
        const workingDomain = await discoverWorkingDomain();
        const sitemapIndexUrl = `${workingDomain}/sitemap.xml`;

        console.log(`[HDHub4u] Fetching sitemap from: ${sitemapIndexUrl}`);
        let body;
        try {
            const response = await makeRequest(sitemapIndexUrl);
            body = response.body;
        } catch (err) {
            body = '';
        }

        // If Cloudflare-blocked, try FlareSolverr
        if (!body || isCloudflareChallenge(body)) {
            console.log(`[HDHub4u] Sitemap index blocked by Cloudflare, trying FlareSolverr`);
            const flareResponse = await fetchWithFlareSolverr(sitemapIndexUrl);
            if (flareResponse && flareResponse.body) {
                body = flareResponse.body;
            } else {
                console.error(`[HDHub4u] FlareSolverr failed for sitemap index`);
                return sitemapCache.entries;
            }
        }

        let postSitemaps;

        // Try XML parsing first, fall back to HTML extraction
        // (FlareSolverr renders XML as HTML via browser)
        try {
            const parsed = await parseStringPromise(body);
            const sitemaps = parsed?.sitemapindex?.sitemap || [];
            postSitemaps = sitemaps
                .map(item => item.loc?.[0])
                .filter(loc => typeof loc === 'string' && loc.includes('post-sitemap'));
        } catch {
            console.log(`[HDHub4u] XML parsing failed for sitemap index, extracting URLs from HTML`);
            postSitemaps = extractSitemapUrlsFromHtml(body, 'post-sitemap');
        }

        const unique = [];
        const seen = new Set();
        for (const loc of postSitemaps) {
            if (!loc || seen.has(loc)) continue;
            seen.add(loc);
            unique.push(loc);
        }

        console.log(`[HDHub4u] Found ${unique.length} post sitemaps`);
        sitemapCache.entries = unique;
        sitemapCache.fetchedAt = now;
        return unique;
    } catch (error) {
        console.error('[HDHub4u] Failed to fetch sitemap index:', error.message);
        return sitemapCache.entries;
    }
}

async function fetchSitemapEntries(url) {
    try {
        let body;
        try {
            const response = await makeRequest(url);
            body = response.body;
        } catch (err) {
            body = '';
        }

        // If Cloudflare-blocked, try FlareSolverr
        if (!body || isCloudflareChallenge(body)) {
            console.log(`[HDHub4u] Sitemap ${url} blocked by Cloudflare, trying FlareSolverr`);
            const flareResponse = await fetchWithFlareSolverr(url);
            if (flareResponse && flareResponse.body) {
                body = flareResponse.body;
            } else {
                console.error(`[HDHub4u] FlareSolverr failed for sitemap ${url}`);
                return [];
            }
        }

        // Try XML parsing first, fall back to HTML extraction
        try {
            const parsed = await parseStringPromise(body);
            const urls = parsed?.urlset?.url || [];

            return urls
                .map(item => {
                    const loc = item.loc?.[0];
                    if (!loc) return null;
                    return {
                        url: loc,
                        slug: normalizeSlug(loc),
                        lastmod: item.lastmod?.[0] || null
                    };
                })
                .filter(Boolean);
        } catch {
            console.log(`[HDHub4u] XML parsing failed for ${url}, extracting URLs from HTML`);
            // Extract hostname from the sitemap URL for filtering
            let baseHost = null;
            try { baseHost = new URL(url).hostname.replace(/^new\d+\./, ''); } catch {}
            return extractSitemapEntriesFromHtml(body, baseHost);
        }
    } catch (error) {
        console.error(`[HDHub4u] Failed to fetch sitemap entries for ${url}:`, error.message);
        return [];
    }
}

async function buildFuseIndex() {
    const now = Date.now();
    if (fuseIndex && now - fuseBuiltAt < SITEMAP_CACHE_TTL) {
        return fuseIndex;
    }

    if (buildingFusePromise) {
        return buildingFusePromise;
    }

    buildingFusePromise = (async () => {
        try {
            const sitemapUrls = await fetchSitemapList();

            // OPTIMIZATION: Fetch all sitemaps in PARALLEL instead of sequential
            // This reduces 15 sequential requests (~7.5s) to parallel (~0.8s)
            console.log(`[HDHub4u] Fetching ${sitemapUrls.length} sitemaps in parallel...`);
            const startTime = Date.now();

            const sitemapResults = await Promise.all(
                sitemapUrls.map(sitemapUrl => fetchSitemapEntries(sitemapUrl))
            );
            const allEntries = sitemapResults.flat();

            console.log(`[HDHub4u] Fetched ${allEntries.length} entries from ${sitemapUrls.length} sitemaps in ${Date.now() - startTime}ms`);

            fuseIndex = new Fuse(allEntries, {
                includeScore: true,
                threshold: 0.4,
                minMatchCharLength: 2,
                keys: ['slug']
            });
            fuseBuiltAt = Date.now();
            return fuseIndex;
        } finally {
            buildingFusePromise = null;
        }
    })();

    return buildingFusePromise;
}

export async function searchHdHub4uPosts(query, limit = 10) {
    if (!query) return [];

    const fuse = await buildFuseIndex();
    if (!fuse) return [];

    const results = fuse.search(cleanTitle(query), { limit: Math.max(limit * 2, 20) })
        .map(result => ({
            url: result.item.url,
            slug: result.item.slug,
            score: result.score,
            lastmod: result.item.lastmod || null
        }));

    if (results.length > 0) {
        const unique = [];
        const seen = new Set();
        for (const item of results) {
            if (!seen.has(item.url)) {
                seen.add(item.url);
                unique.push(item);
            }
            if (unique.length >= limit) break;
        }
        return unique;
    }

    return [];
}

function normalizeLink(href, baseUrl) {
    if (!href) return null;
    // Use discovered domain as fallback, or first known domain
    const fallbackBase = discoveredBaseUrl || getBaseUrls()[0] || DEFAULT_BASE_URLS[0];
    const resolveBase = baseUrl || fallbackBase;
    try {
        return new URL(href, resolveBase).toString();
    } catch {
        return null;
    }
}

function extractFilenameFromUrl(url) {
    if (!url) return null;
    try {
        const urlObj = new URL(url);

        // Skip redirect/shortlink URLs that won't have meaningful filenames
        if (urlObj.search || urlObj.hostname.includes('gadgetsweb') || urlObj.hostname.includes('hblinks')) {
            return null;
        }

        const pathname = urlObj.pathname;
        // Get the last segment of the path
        const segments = pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
            let filename = segments[segments.length - 1];
            // Remove common file extensions
            filename = filename.replace(/\.(mkv|mp4|avi|webm|m3u8|html)$/i, '');
            // Decode URI component
            try {
                filename = decodeURIComponent(filename);
            } catch (e) {
                // If decoding fails, use as-is
            }
            // Check if it looks like a meaningful filename (not just a random hash or ID)
            // Skip if it's very short (likely an ID) or very long (likely encoded data)
            if (filename.length > 10 && filename.length < 200) {
                // Skip if it looks like a random hash (all hex or alphanumeric with no spaces/dashes)
                if (/^[a-f0-9]{20,}$/i.test(filename) || /^[a-zA-Z0-9]{32,}$/i.test(filename)) {
                    return null;
                }
                // Should contain some meaningful characters (letters, spaces, or dashes)
                if (/[a-z].*[a-z]/i.test(filename)) {
                    return filename;
                }
            }
        }
    } catch {
        // Invalid URL
    }
    return null;
}

function shouldIncludeLink(url) {
    if (!url) return false;
    const lower = url.toLowerCase();

    // Exclude links back to the site itself and anchor links
    if (lower.includes('#')) return false;

    // Exclude redirect services and other non-drive links
    if (EXCLUDED_PATTERNS.some(pattern => lower.includes(pattern))) {
        return false;
    }

    try {
        const urlObj = new URL(url);
        // Use dynamic hosts list to include discovered domain
        const currentHosts = getBaseHosts();
        if (currentHosts.includes(urlObj.hostname.toLowerCase())) {
            return false;
        }
    } catch {
        // Ignore URL parsing errors and fall back to pattern checks below
    }

    // Check if URL contains any of our drive hosting patterns OR gadgetsweb (for series episodes)
    const hasHostPattern = HOST_PATTERNS.some(pattern => lower.includes(pattern)) || lower.includes('gadgetsweb');
    if (!hasHostPattern) return false;

    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const hostname = urlObj.hostname.toLowerCase();

        // Filter out homepage/root URLs that won't have actual files
        // BUT allow gadgetsweb.xyz/?id= links (series episode redirectors) even though pathname is '/'
        if ((pathname === '/' || pathname === '') && !hostname.includes('gadgetsweb')) {
            return false;
        }

        // For drive hosting services, require /file/ or /drive/ or /d/ in path
        // These are the actual file pages where we can extract filename and size
        if (hostname.includes('hubdrive') || hostname.includes('hubcloud') || hostname.includes('hubcdn')) {
            return pathname.includes('/file/') || pathname.includes('/drive/') || pathname.includes('/d/');
        }

        // For gadgetsweb.xyz, accept any URL with ?id= parameter (base64-encoded redirect)
        if (hostname.includes('gadgetsweb')) {
            return urlObj.searchParams.has('id');
        }

        return false;
    } catch (error) {
        // If URL parsing fails, reject it
        return false;
    }
}

function extractSize(label) {
    if (!label) return null;
    const cleaned = label.replace(/\s+/g, ' ');
    const match = cleaned.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    if (!match) return null;
    return `${match[1]} ${match[2].toUpperCase()}`;
}

function extractSeasonEpisode(label) {
    if (!label) return {};

    const seasonMatch = label.match(/S(?:eason)?\s*0*(\d+)/i);
    const episodeMatch = label.match(/E(?:pisode)?\s*0*(\d+)/i) || label.match(/\bEp?\s*0*(\d+)/i);

    const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
    const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;

    return { season, episode };
}

const ARCHIVE_LABEL_KEYWORDS = [
    'pack',
    'full series',
    'all episodes',
    'complete series',
    'complete season',
    'full season',
    's01-s04',
    'season pack',
    "ep's",      // Plural "EP's" indicates multi-episode pack
    "– ep's",    // Common format: "4K/2160p SDR MULTi WEB-DL – EP's [GD]"
    "[gd]",      // Google Drive packs
    "vol1",      // Volume packs
    "vol-1",
    "vol 1"
];

function isArchiveLabel(label) {
    const normalized = label.toLowerCase();
    return ARCHIVE_LABEL_KEYWORDS.some(keyword => normalized.includes(keyword));
}

function collapseWhitespace(value) {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim();
}

function findEpisodeHeaderText($, $element) {
    const parentHeader = $element.closest('h4');
    if (!parentHeader.length) {
        return '';
    }

    const episodeHeader = parentHeader.prevAll('h4').filter((_, hdr) => {
        const text = $(hdr).text();
        return /(episode|ep)\s*\d+/i.test(text);
    });

    if (episodeHeader.length) {
        return collapseWhitespace(episodeHeader.first().text());
    }

    return '';
}

function extractResolutionFromHeader($, $element) {
    const parentHeader = $element.closest('h4');
    if (!parentHeader.length) return null;
    const headerText = collapseWhitespace(parentHeader.text());
    const match = headerText.match(/(2160p|1080p|720p|480p|4k)/i);
    return match ? match[0].toLowerCase() : null;
}

function extractContextFromSurroundingElements($, $element) {
    // Try to find meaningful context from surrounding elements
    const contexts = [];

    // Check parent paragraph or div for additional text
    const $parent = $element.parent();
    if ($parent.length) {
        const parentText = collapseWhitespace($parent.text());
        const linkText = collapseWhitespace($element.text());

        // Get text that's NOT part of the link itself
        const contextText = parentText.replace(linkText, '').trim();
        if (contextText && contextText.length > 10 && contextText.length < 300) {
            // Check if it looks like a filename or meaningful description
            if (/\.(mkv|mp4|avi|webm)|[0-9]+\.?[0-9]*\s*(gb|mb)|bluray|webrip|web-dl|hdtv|remux/i.test(contextText)) {
                // Filter out player IDs and random codes
                if (!/player-?\d+|[a-z0-9]{10,}/i.test(contextText) || /\d+\.?\d*\s*(gb|mb)/i.test(contextText)) {
                    contexts.push(contextText);
                }
            }
        }
    }

    // Check for strong/bold tags near the link
    const $strong = $element.closest('p, div, li').find('strong, b').first();
    if ($strong.length) {
        const strongText = collapseWhitespace($strong.text());
        if (strongText && strongText.length > 5 && !contexts.includes(strongText)) {
            // Filter out player IDs and watch online buttons
            if (!/watch|player-?\d+|online/i.test(strongText) || /\d+\.?\d*\s*(gb|mb)/i.test(strongText)) {
                contexts.push(strongText);
            }
        }
    }

    // Look for preceding text nodes or spans that might contain filename info
    const $prevSiblings = $element.prevAll().slice(0, 3);
    $prevSiblings.each((_, sibling) => {
        const siblingText = collapseWhitespace($(sibling).text());
        if (siblingText && siblingText.length > 10 && siblingText.length < 200) {
            if (/\.(mkv|mp4|avi|webm)|[0-9]+\.?[0-9]*\s*(gb|mb)|bluray|webrip|web-dl|hdtv/i.test(siblingText)) {
                if (!contexts.includes(siblingText)) {
                    contexts.push(siblingText);
                }
            }
        }
    });

    return contexts.length > 0 ? contexts[0] : null;
}

function buildHdHubLinkLabel($, $element, baseLabel) {
    const parts = [];
    const episodeHeaderText = findEpisodeHeaderText($, $element);
    if (episodeHeaderText) {
        parts.push(episodeHeaderText);
    }

    const parentHeader = $element.closest('h4');
    const parentText = parentHeader.length ? collapseWhitespace(parentHeader.text()) : '';

    // If baseLabel is generic or too short, try to find better context
    const isGenericBaseLabel = !baseLabel ||
        baseLabel.length < 8 ||
        /^(download|click|here|link|watch|stream|play|4khdhub|hdhub4u|gdflix|hubcloud|hubdrive)$/i.test(baseLabel.trim());

    if (isGenericBaseLabel) {
        // Try to extract better context from surrounding elements first
        const surroundingContext = extractContextFromSurroundingElements($, $element);
        if (surroundingContext) {
            // Check if surrounding context is different from parent header
            const normalizedContext = surroundingContext.toLowerCase();
            const normalizedParent = parentText.toLowerCase();

            if (normalizedContext !== normalizedParent && !normalizedContext.includes(normalizedParent) && !normalizedParent.includes(normalizedContext)) {
                // Both are different, add both
                if (parentText) parts.push(parentText);
                parts.push(surroundingContext);
            } else {
                // They're similar or same, use the longer/more descriptive one
                parts.push(surroundingContext.length > parentText.length ? surroundingContext : parentText);
            }
        } else if (parentText) {
            // No surrounding context found, use parent header
            parts.push(parentText);
        } else if (baseLabel) {
            // Fall back to original label
            parts.push(baseLabel);
        }
    } else {
        // baseLabel is meaningful, check if it's different from parentText
        const normalizedLabel = baseLabel.toLowerCase();
        const normalizedParent = parentText.toLowerCase();

        if (parentText && normalizedLabel !== normalizedParent && !normalizedLabel.includes(normalizedParent) && !normalizedParent.includes(normalizedLabel)) {
            // Both are different, add both
            parts.push(parentText);
            parts.push(baseLabel);
        } else if (parentText && normalizedParent.includes(normalizedLabel)) {
            // Parent includes label, just use parent
            parts.push(parentText);
        } else {
            // Use baseLabel
            parts.push(baseLabel);
        }
    }

    const resolutionHint = extractResolutionFromHeader($, $element);
    if (resolutionHint && !parts.some(part => part.toLowerCase().includes(resolutionHint.toLowerCase()))) {
        parts.push(resolutionHint);
    }

    const label = parts.filter(Boolean).join(' ').trim();
    const hasEpisodeContext = Boolean(episodeHeaderText);
    return { label, hasEpisodeContext };
}

function cleanLinkLabel(label, rawLabel) {
    if (!label) return label;

    let cleaned = label;
    const hasInstantContext = /\bInstant\b/i.test(cleaned);
    const rawHasInstant = rawLabel && /\bInstant\b/i.test(rawLabel);

    if (hasInstantContext && !rawHasInstant) {
        cleaned = cleaned.replace(/\bInstant\b/gi, '');
        cleaned = cleaned.replace(/\bWATCH\b/gi, '');
        cleaned = cleaned.replace(/\s*\|\s*/g, ' ');
    }

    return collapseWhitespace(cleaned);
}

export async function loadHdHub4uPost(url, signal = null) {
    if (!url) return null;

    const cached = pageCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < PAGE_CACHE_TTL) {
        return cached.data;
    }

    try {
        let $;
        const response = await makeRequest(url, {
            parseHTML: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal
        });

        $ = response.document;

        // If Cloudflare-blocked, try FlareSolverr
        if (!$ || isCloudflareChallenge(response.body, response.statusCode)) {
            console.log(`[HDHub4u] Post page blocked by Cloudflare, trying FlareSolverr: ${url}`);
            const flareResponse = await fetchWithFlareSolverr(url);
            if (flareResponse && flareResponse.body) {
                $ = cheerio.load(flareResponse.body);
            } else {
                console.error(`[HDHub4u] FlareSolverr failed for post: ${url}`);
                return null;
            }
        }

        if (!$) {
            throw new Error('Failed to parse page HTML');
        }

        const ogTitle = $('meta[property="og:title"]').attr('content');
        const entryTitle = $('h1.entry-title').first().text();
        const pageTitle = $('h1.page-title .material-text').first().text()
            || $('h1.page-title').first().text();
        const fallbackH1 = $('h1').first().text();
        const docTitle = $('title').first().text();
        const rawTitle = ogTitle || entryTitle || pageTitle || fallbackH1 || docTitle || '';
        const title = collapseWhitespace(rawTitle).replace(/\s*[–-]\s*HDHub4u.*$/i, '').trim();

        // Try to extract year from title only
        // Note: We only look in the title to avoid false positives from publication dates
        let year = null;
        const titleYearMatch = title.match(/\((\d{4})\)/);  // Match year in parentheses first
        if (titleYearMatch) {
            const extractedYear = parseInt(titleYearMatch[1]);
            // Only accept years that make sense for movies/shows (1900-2030)
            if (extractedYear >= 1900 && extractedYear <= 2030) {
                year = extractedYear;
            }
        } else {
            // If no parentheses, try standalone 4-digit year
            const standaloneYearMatch = title.match(/\b(19\d{2}|20[0-2]\d)\b/);
            if (standaloneYearMatch) {
                const extractedYear = parseInt(standaloneYearMatch[1]);
                if (extractedYear >= 1900 && extractedYear <= 2030) {
                    year = extractedYear;
                }
            }
        }

        const type = /season|s0*\d+/.test(normalizeSlug(url)) ? 'series' : 'movie';

        // Extract languages from page title (e.g., "Dual-Audio [Hindi & English]")
        const titleLanguages = detectLanguagesFromTitle(title);
        console.log(`[HDHub4u] Detected languages from page title "${title}":`, titleLanguages);

        const links = new Map();
        $('a[href]').each((_, element) => {
            const href = $(element).attr('href');
            const normalized = normalizeLink(href, url);
            if (!normalized || !shouldIncludeLink(normalized)) return;

            const text = $(element).text().replace(/\s+/g, ' ').trim();
            const titleAttr = $(element).attr('title')?.replace(/\s+/g, ' ').trim();
            const rawLabel = titleAttr || text || '';
            let baseLabel = rawLabel;

            // Try to extract a meaningful filename from the URL
            const urlFilename = extractFilenameFromUrl(normalized);
            if (urlFilename) {
                // Use URL filename if the baseLabel is generic or too short
                const isGenericLabel = !baseLabel ||
                    baseLabel.length < 5 ||
                    /^(download|click|here|link|watch|stream|play)$/i.test(baseLabel.trim());

                if (isGenericLabel) {
                    baseLabel = urlFilename;
                } else {
                    // Append URL filename to baseLabel for more context
                    baseLabel = `${urlFilename} ${baseLabel}`;
                }
            }

            if (!baseLabel) return;

            const { label: builtLabel, hasEpisodeContext } = buildHdHubLinkLabel($, $(element), baseLabel);
            const isInstantLink = /\bInstant\b/i.test(rawLabel) || (!rawLabel && /\bInstant\b/i.test(builtLabel));
            const label = cleanLinkLabel(builtLabel, rawLabel);
            if (!label || label.toLowerCase().includes('sample')) return;
            if (!hasEpisodeContext && isArchiveLabel(label)) return;

            // Skip "Instant" links - these are low-quality redirect links that often fail
            if (isInstantLink) return;

            if (!links.has(normalized)) {
                const linkLanguages = detectLanguagesFromTitle(label);
                // Use link languages if available, otherwise fall back to title languages
                const languages = linkLanguages.length > 0 ? linkLanguages : titleLanguages;
                links.set(normalized, {
                    url: normalized,
                    label,
                    size: extractSize(label),
                    quality: getResolutionFromName(label),
                    languages,
                    isInstant: isInstantLink,
                    ...extractSeasonEpisode(label)
                });
            }
        });

        const data = {
            url,
            title,
            year,
            type,
            titleLanguages,
            downloadLinks: Array.from(links.values())
        };

        pageCache.set(url, { fetchedAt: Date.now(), data });
        return data;
    } catch (error) {
        console.error(`[HDHub4u] Failed to load post ${url}:`, error.message);
        return null;
    }
}

/**
 * Force refresh domain discovery (useful for testing or when domain changes)
 */
export function resetDomainDiscovery() {
    discoveredBaseUrl = null;
    discoveryTimestamp = 0;
    discoveryPromise = null;
    // Also clear sitemap cache since URLs might change
    sitemapCache.entries = [];
    sitemapCache.fetchedAt = 0;
}

/**
 * Get the current discovered domain (for diagnostics/testing)
 */
export function getDiscoveredDomain() {
    return discoveredBaseUrl;
}

// Export for testing
export { discoverWorkingDomain };
