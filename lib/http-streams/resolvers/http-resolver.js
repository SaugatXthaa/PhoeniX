// lib/http-streams/resolvers/http-resolver.js
// Real resolver — ported from sootio-stremio-addon/lib/http-streams/resolvers/http-resolver.js
// Resolves redirect URLs (gadgetsweb.xyz, hubcloud.in, modpro.blog, etc.) to direct video URLs
//
// Resolution chain:
//   1. If URL has ?id= param → call getRedirectLinks() to decode the gadgetsweb redirect
//   2. Call processExtractorLinkWithAwait() to extract FSL/PixelServer/workers.dev direct links
//   3. Validate each candidate with validateSeekableUrl() (206 Partial Content check)
//   4. Return first seekable URL

import { getRedirectLinks, processExtractorLinkWithAwait } from '../providers/4khdhub/extraction.js';
import { validateSeekableUrl } from '../utils/validation.js';
import { makeRequest } from '../utils/http.js';

const FAST_SEEK_TIMEOUT_MS = parseInt(process.env.HTTP_STREAM_SEEK_TIMEOUT_MS, 10) || 3000;
const MAX_PARALLEL_VALIDATIONS = parseInt(process.env.HTTP_STREAM_MAX_PARALLEL, 10) || 3;
// Cache TTL: short for URLs that may expire (Google UserContent tokens expire ~3 min),
// longer for stable CDN URLs (workers.dev, fileshubcdn, pixeldrain don't expire)
const RESOLVE_CACHE_TTL_SHORT = parseInt(process.env.HTTP_STREAM_RESOLVE_CACHE_TTL_SHORT, 10) || (2 * 60 * 1000);  // 2 min
const RESOLVE_CACHE_TTL_LONG  = parseInt(process.env.HTTP_STREAM_RESOLVE_CACHE_TTL, 10)       || (10 * 60 * 1000); // 10 min

const resolveCache = new Map();
const DIRECT_HOST_HINTS = ['workers.dev', 'hubcdn.fans', 'r2.dev', 'pixeldrain', 'fileshubcdn'];

// URLs containing these patterns expire quickly (Google Drive download tokens)
const EXPIRING_URL_PATTERNS = ['video-downloads.googleusercontent.com', 'gpdl.hubcloud', 'drive.google.com'];

function isExpiringUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return EXPIRING_URL_PATTERNS.some(p => lower.includes(p));
}

function getCacheTtl(url) {
    return isExpiringUrl(url) ? RESOLVE_CACHE_TTL_SHORT : RESOLVE_CACHE_TTL_LONG;
}

// Non-video extensions to filter out
const NON_VIDEO_EXTENSIONS = ['.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.iso', '.dmg', '.pkg', '.msi', '.deb', '.rpm', '.txt', '.nfo', '.sfv', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.css', '.js'];

function isNonVideoFile(filename) {
    if (!filename) return false;
    const lower = filename.toLowerCase();
    return NON_VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function evaluateVideoCandidate(candidate) {
    if (!candidate?.url) return { isVideo: false, reason: 'no URL' };

    // Check URL extension
    try {
        const urlObj = new URL(candidate.url);
        const pathname = urlObj.pathname.toLowerCase();
        if (NON_VIDEO_EXTENSIONS.some(ext => pathname.endsWith(ext))) {
            return { isVideo: false, reason: `non-video extension in URL: ${pathname}` };
        }
    } catch {
        // ignore
    }

    // Check title/name for non-video extensions
    const title = candidate.title || candidate.name || '';
    if (title && isNonVideoFile(title)) {
        return { isVideo: false, reason: `non-video file: ${title}` };
    }

    return { isVideo: true };
}

async function findSeekableLink(results, { timeoutMs = FAST_SEEK_TIMEOUT_MS, maxParallel = MAX_PARALLEL_VALIDATIONS } = {}) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const cache = new Map();

    const checkUrl = async (candidate, label) => {
        if (!candidate?.url) return null;
        if (cache.has(candidate.url)) return cache.get(candidate.url);

        const { isVideo, reason } = evaluateVideoCandidate(candidate);
        if (!isVideo) {
            console.log(`[HTTP-RESOLVE] Skipping ${label} link: ${reason}`);
            cache.set(candidate.url, null);
            return null;
        }

        try {
            const validation = await validateSeekableUrl(candidate.url, {
                requirePartialContent: false,
                timeout: timeoutMs
            });

            // Check if Content-Disposition reveals non-video file
            if (validation.filename && isNonVideoFile(validation.filename)) {
                console.log(`[HTTP-RESOLVE] Skipping ${label} link - non-video file: ${validation.filename}`);
                cache.set(candidate.url, null);
                return null;
            }

            if (validation.isValid) {
                console.log(`[HTTP-RESOLVE] Selected ${label} link (status: ${validation.statusCode})`);
                cache.set(candidate.url, candidate.url);
                return candidate.url;
            }

            // Allow pixeldrain even without 206 (they sometimes block HEAD)
            const hostname = (() => {
                try { return new URL(candidate.url).hostname.toLowerCase(); } catch { return ''; }
            })();
            if (hostname.includes('pixeldrain') && [403, 451].includes(validation.statusCode)) {
                console.log(`[HTTP-RESOLVE] Allowing ${label} Pixeldrain link despite ${validation.statusCode}`);
                cache.set(candidate.url, candidate.url);
                return candidate.url;
            }

            console.log(`[HTTP-RESOLVE] Rejected ${label} link (status: ${validation.statusCode || 'unknown'})`);
            cache.set(candidate.url, null);
            return null;
        } catch (error) {
            console.log(`[HTTP-RESOLVE] Error validating ${label}: ${error.message}`);
            cache.set(candidate.url, null);
            return null;
        }
    };

    // Sort by priority (higher first), with non-expiring CDN URLs preferred over
    // Google UserContent URLs (which expire in ~3 minutes)
    const sortedResults = [...results].sort((a, b) => {
        const aExpiring = isExpiringUrl(a.url) ? 1 : 0;
        const bExpiring = isExpiringUrl(b.url) ? 1 : 0;
        if (aExpiring !== bExpiring) return aExpiring - bExpiring; // non-expiring first
        return (b.priority ?? 0) - (a.priority ?? 0);
    });

    const seen = new Set();
    const candidates = [];
    for (const candidate of sortedResults) {
        if (!candidate?.url || seen.has(candidate.url)) continue;
        const label = candidate.serverType || candidate.name || 'Unknown';
        candidates.push({ candidate, label });
        seen.add(candidate.url);
    }

    console.log(`[HTTP-RESOLVE] Testing ${candidates.length} candidates in priority order`);

    // Validate in parallel batches
    const batchSize = Math.max(1, maxParallel);
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const validationResults = await Promise.all(
            batch.map(entry => checkUrl(entry.candidate, entry.label))
        );
        const winner = validationResults.find(r => r !== null && r !== undefined);
        if (winner) return winner;
    }

    return null;
}

/**
 * Resolve a redirect URL to its final direct streaming link.
 * Called by /resolve/httpstreaming endpoint when user clicks play.
 *
 * @param {string} redirectUrl - The encoded redirect URL
 * @returns {Promise<string|null>} - Final direct streaming URL or null
 */
export async function resolveHttpStreamUrl(redirectUrl) {
    if (!redirectUrl) return null;

    const decodedUrl = decodeURIComponent(redirectUrl);
    console.log(`[HTTP-RESOLVE] Starting resolution for: ${decodedUrl.substring(0, 100)}...`);

    // Check cache — use URL-specific TTL (short for expiring URLs like Google UserContent)
    const cacheKey = decodedUrl;
    const cached = resolveCache.get(cacheKey);
    if (cached && cached.value) {
        const ttl = getCacheTtl(cached.value);
        if (Date.now() - cached.ts < ttl) {
            console.log(`[HTTP-RESOLVE] Using cached result (TTL=${Math.round(ttl/1000)}s, expiring=${isExpiringUrl(cached.value)})`);
            return cached.value;
        }
        // Cache expired — evict
        resolveCache.delete(cacheKey);
    }

    let workingUrl = decodedUrl;

    // Fast-path: direct hosts (workers.dev, hubcdn.fans, r2.dev, pixeldrain)
    if (DIRECT_HOST_HINTS.some(h => workingUrl.includes(h))) {
        console.log('[HTTP-RESOLVE] Direct host detected, validating...');
        try {
            const validation = await validateSeekableUrl(workingUrl, { requirePartialContent: false, timeout: FAST_SEEK_TIMEOUT_MS });
            if (validation.isValid) {
                console.log('[HTTP-RESOLVE] Direct host validated successfully');
                resolveCache.set(cacheKey, { value: workingUrl, ts: Date.now() });
                return workingUrl;
            }
        } catch (err) {
            console.log(`[HTTP-RESOLVE] Direct host validation failed: ${err.message}`);
        }
        // Even if validation fails, return the direct URL (Nuvio's player may handle it)
        resolveCache.set(cacheKey, { value: workingUrl, ts: Date.now() });
        return workingUrl;
    }

    // Step 1: Resolve gadgetsweb.xyz/?id= redirect if present
    const hasRedirectParam = /[?&]id=/i.test(workingUrl);
    if (hasRedirectParam) {
        console.log('[HTTP-RESOLVE] Resolving gadgetsweb redirect...');
        try {
            const fileHostingUrl = await getRedirectLinks(workingUrl);
            if (!fileHostingUrl || !fileHostingUrl.trim()) {
                console.log('[HTTP-RESOLVE] Failed to resolve gadgetsweb redirect');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
            workingUrl = fileHostingUrl.trim();
            console.log(`[HTTP-RESOLVE] Resolved to file hosting URL: ${workingUrl.substring(0, 100)}...`);
        } catch (err) {
            console.log(`[HTTP-RESOLVE] Redirect resolution failed: ${err.message}`);
            resolveCache.set(cacheKey, { value: null, ts: Date.now() });
            return null;
        }
    }

    // Step 2: Extract direct video URLs from HubCloud/HubDrive page
    console.log('[HTTP-RESOLVE] Extracting direct video URLs...');
    let extracted;
    try {
        extracted = await processExtractorLinkWithAwait(workingUrl, 99);
    } catch (err) {
        console.log(`[HTTP-RESOLVE] Extraction failed: ${err.message}`);
        resolveCache.set(cacheKey, { value: null, ts: Date.now() });
        return null;
    }

    if (!extracted || !Array.isArray(extracted) || extracted.length === 0) {
        console.log('[HTTP-RESOLVE] No streams found after extraction');

        // Fallback: if the URL itself looks like a direct video URL, return it
        if (/\.(mp4|mkv|avi|webm|m3u8)(\?|$)/i.test(workingUrl)) {
            console.log('[HTTP-RESOLVE] URL appears to be direct video, returning as-is');
            resolveCache.set(cacheKey, { value: workingUrl, ts: Date.now() });
            return workingUrl;
        }

        resolveCache.set(cacheKey, { value: null, ts: Date.now() });
        return null;
    }

    // Filter out null/empty entries
    const sanitizedResults = extracted.filter(r => r && r.url);
    if (sanitizedResults.length === 0) {
        console.log('[HTTP-RESOLVE] No usable streams after filtering');
        resolveCache.set(cacheKey, { value: null, ts: Date.now() });
        return null;
    }

    console.log(`[HTTP-RESOLVE] Found ${sanitizedResults.length} potential stream(s)`);
    sanitizedResults.forEach((r, idx) => {
        const type = r.url.includes('pixeldrain') ? 'Pixeldrain' :
            r.url.includes('googleusercontent') ? 'GoogleUserContent' :
            r.url.includes('workers.dev') ? 'Workers.dev' :
            r.url.includes('hubcdn') ? 'HubCDN' :
            r.url.includes('r2.dev') ? 'R2' : 'Other';
        console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${type}] ${r.url.substring(0, 80)}...`);
    });

    // Step 3: Find a seekable link (supports 206 Partial Content)
    const seekableLink = await findSeekableLink(sanitizedResults);
    if (seekableLink) {
        console.log(`[HTTP-RESOLVE] Returning seekable link: ${seekableLink.substring(0, 100)}...`);
        resolveCache.set(cacheKey, { value: seekableLink, ts: Date.now() });
        return seekableLink;
    }

    // Fallback: return the highest priority link even without 206 confirmation
    // (Nuvio's player may still be able to play it). Prefer non-expiring URLs.
    const fallback = sanitizedResults.sort((a, b) => {
        const aExpiring = isExpiringUrl(a.url) ? 1 : 0;
        const bExpiring = isExpiringUrl(b.url) ? 1 : 0;
        if (aExpiring !== bExpiring) return aExpiring - bExpiring;
        return (b.priority ?? 0) - (a.priority ?? 0);
    })[0];
    if (fallback?.url) {
        console.log(`[HTTP-RESOLVE] No 206-confirmed link found, returning highest priority: ${fallback.url.substring(0, 100)}...`);
        resolveCache.set(cacheKey, { value: fallback.url, ts: Date.now() });
        return fallback.url;
    }

    console.log('[HTTP-RESOLVE] No valid stream URL found');
    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
    return null;
}

export function prewarmHttpStreamUrls(urls = []) {
    // No-op for now — just a placeholder for API compatibility
    for (const url of urls) {
        if (!url) continue;
        resolveHttpStreamUrl(url).catch(() => {});
    }
}
