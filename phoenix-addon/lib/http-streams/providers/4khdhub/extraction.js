/**
 * 4KHDHub Link Extraction Module
 * Handles extraction of streaming links from HubCloud and HubDrive
 */

import { URL } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import { makeRequest } from '../../utils/http.js';
import { getIndexQuality, getBaseUrl } from '../../utils/parsing.js';
import { base64Decode, rot13 } from '../../utils/encoding.js';
import { validateSeekableUrl } from '../../utils/validation.js';
import * as SqliteCache from '../../../util/cache-store.js';
import * as config from '../../../config.js';
import flaresolverrManager from '../../../util/flaresolverr-manager.js';

// FlareSolverr configuration
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const FLARESOLVERR_V2 = config.FLARESOLVERR_V2 || process.env.FLARESOLVERR_V2 === 'true';
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || process.env.FLARESOLVERR_PROXY_URL || '';
const FLARESOLVERR_PROXY_ALLOW_HUBCLOUD = process.env.FLARESOLVERR_PROXY_HUBCLOUD !== 'false';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.HUBDRIVE_FLARESOLVERR_TIMEOUT, 10) || 45000;
const HUBCLOUD_USER_AGENT = config.HTTP_STREAM_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FLARE_SESSION_TTL = parseInt(process.env.HUBDRIVE_FLARE_SESSION_TTL, 10) || (10 * 60 * 1000);
const FLARE_LOCK_DIR = process.env.HUBDRIVE_FLARE_LOCK_DIR || '/tmp/sootio-flaresolverr';
const FLARE_LOCK_TTL = parseInt(process.env.HUBDRIVE_FLARE_LOCK_TTL, 10) || 2 * 60 * 1000;
const FLARE_LOCK_WAIT_MS = parseInt(process.env.HUBDRIVE_FLARE_LOCK_WAIT_MS, 10) || 20000;

// Cache configuration
const EXTRACTION_CACHE_TTL = parseInt(process.env.HUBCLOUD_EXTRACTION_CACHE_TTL, 10) || 5 * 60 * 1000; // 5 minutes
const CF_COOKIE_CACHE_TTL = parseInt(process.env.HUBDRIVE_CF_COOKIE_TTL, 10) || 0; // 0 = reuse until denied
const CF_COOKIE_CACHE_SERVICE = 'hubdrive_cf_cookie';
const CF_COOKIE_CACHE_PREFIX = 'cf_cookie:';

// In-memory cache only for extraction results
const extractionCache = new Map(); // url -> { data, ts }
const cfCookieCache = new Map(); // domain -> { cookies, userAgent, timestamp, requiresProxy }
const flareSolverrLocks = new Map(); // domain -> Promise (prevents thundering herd)
const flareSessionCache = new Map(); // domain -> { sessionId, ts }

// Known dead HubCloud domains that should be skipped (no DNS records)
const DEAD_HUBCLOUD_DOMAINS = new Set([
    'hubcloud.ink',
    'hubcloud.co',
    'hubcloud.cc',
    'hubcloud.me',
    'hubcloud.xyz'
]);

/**
 * Check if a URL is from a known dead HubCloud domain
 * @param {string} url - URL to check
 * @returns {boolean} True if the domain is dead and should be skipped
 */
function isDeadHubcloudDomain(url) {
    if (!url) return false;
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return DEAD_HUBCLOUD_DOMAINS.has(hostname);
    } catch {
        return false;
    }
}

function shouldUseFlareProxy(url) {
    if (!FLARESOLVERR_PROXY_URL || !url) return false;
    const lower = url.toLowerCase();
    if (!FLARESOLVERR_PROXY_ALLOW_HUBCLOUD && (lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('hubcdn'))) {
        return false;
    }
    return true;
}

function shouldBypassHttpProxy(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('hubcdn');
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
 * Check if a response body contains a Cloudflare challenge
 * @param {string} body - Response body
 * @param {number} statusCode - HTTP status code
 * @returns {boolean}
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

function cleanTitle(title = '') {
    const parts = String(title).split(/[.\-_]/);
    const qualityTags = [
        'WEBRip', 'WEB-DL', 'WEB', 'BluRay', 'HDRip', 'DVDRip', 'HDTV',
        'CAM', 'TS', 'R5', 'DVDScr', 'BRRip', 'BDRip', 'DVD', 'PDTV', 'HD'
    ];
    const audioTags = ['AAC', 'AC3', 'DTS', 'MP3', 'FLAC', 'DD5', 'EAC3', 'Atmos'];
    const subTags = ['ESub', 'ESubs', 'Subs', 'MultiSub', 'NoSub', 'EnglishSub', 'HindiSub'];
    const codecTags = ['x264', 'x265', 'H264', 'HEVC', 'AVC'];

    const startIndex = parts.findIndex(part =>
        qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );
    const endIndex = parts.findLastIndex(part =>
        subTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        audioTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        codecTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );

    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        return parts.slice(startIndex, endIndex + 1).join('.');
    }
    if (startIndex !== -1) {
        return parts.slice(startIndex).join('.');
    }
    return parts.slice(-3).join('.');
}

async function getCachedCfCookies(domain) {
    if (!domain) return null;
    const memCached = cfCookieCache.get(domain);
    if (memCached?.cookies && memCached?.userAgent) {
        if (CF_COOKIE_CACHE_TTL > 0 && memCached.timestamp) {
            const age = Date.now() - memCached.timestamp;
            if (age > CF_COOKIE_CACHE_TTL) {
                cfCookieCache.delete(domain);
            } else {
                return memCached;
            }
        } else {
            return memCached;
        }
    }

    if (!SqliteCache.isEnabled()) {
        const fileCached = await readFileCookieCache(domain);
        if (fileCached?.cookies && fileCached?.userAgent) {
            cfCookieCache.set(domain, fileCached);
            return fileCached;
        }
        return null;
    }

    try {
        const cached = await SqliteCache.getCachedRecord(CF_COOKIE_CACHE_SERVICE, `${CF_COOKIE_CACHE_PREFIX}${domain}`);
        if (!cached?.data) return null;
        if (CF_COOKIE_CACHE_TTL > 0) {
            const updatedAt = cached.updatedAt || cached.createdAt;
            if (updatedAt) {
                const age = Date.now() - new Date(updatedAt).getTime();
                if (age > CF_COOKIE_CACHE_TTL) return null;
            }
        }
        if (cached.data.cookies && cached.data.userAgent) {
            cfCookieCache.set(domain, cached.data);
            return cached.data;
        }
    } catch (error) {
        console.log(`[HubDrive] Failed to read CF cookie cache: ${error.message}`);
    }
    return null;
}

async function cacheCfCookies(domain, cookies, userAgent, requiresProxy = false) {
    const resolvedUserAgent = userAgent || HUBCLOUD_USER_AGENT;
    if (!domain || !Array.isArray(cookies) || cookies.length === 0 || !resolvedUserAgent) return;
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (!cookieHeader) return;
    const data = {
        cookies: cookieHeader,
        userAgent: resolvedUserAgent,
        timestamp: Date.now(),
        requiresProxy: Boolean(requiresProxy)
    };
    cfCookieCache.set(domain, data);
    if (!SqliteCache.isEnabled()) {
        await writeFileCookieCache(domain, data);
        return;
    }
    try {
        await SqliteCache.upsertCachedMagnet({
            service: CF_COOKIE_CACHE_SERVICE,
            hash: `${CF_COOKIE_CACHE_PREFIX}${domain}`,
            data
        }, { ttlMs: CF_COOKIE_CACHE_TTL });
    } catch (error) {
        console.log(`[HubDrive] Failed to persist CF cookie cache: ${error.message}`);
    }
}

async function clearCachedCfCookies(domain) {
    if (!domain) return;
    cfCookieCache.delete(domain);
    if (!SqliteCache.isEnabled()) {
        await deleteFileCookieCache(domain);
        return;
    }
    try {
        await SqliteCache.deleteCachedHash(CF_COOKIE_CACHE_SERVICE, `${CF_COOKIE_CACHE_PREFIX}${domain}`);
    } catch (error) {
        // Ignore cache delete errors
    }
}

async function ensureLockDir() {
    try {
        await fs.mkdir(FLARE_LOCK_DIR, { recursive: true });
    } catch {
        // ignore - best effort
    }
}

function getDomainLockPath(domain) {
    const safe = (domain || '').replace(/[^a-z0-9_.-]/gi, '_');
    return `${FLARE_LOCK_DIR}/flare_${safe}.lock`;
}

function getDomainCookiePath(domain) {
    const safe = (domain || '').replace(/[^a-z0-9_.-]/gi, '_');
    return `${FLARE_LOCK_DIR}/cf_${safe}.json`;
}

async function readFileCookieCache(domain) {
    try {
        const raw = await fs.readFile(getDomainCookiePath(domain), 'utf8');
        const data = JSON.parse(raw);
        if (!data?.cookies || !data?.userAgent) return null;
        if (CF_COOKIE_CACHE_TTL > 0 && data.timestamp) {
            const age = Date.now() - data.timestamp;
            if (age > CF_COOKIE_CACHE_TTL) return null;
        }
        return data;
    } catch {
        return null;
    }
}

async function writeFileCookieCache(domain, data) {
    try {
        await ensureLockDir();
        await fs.writeFile(getDomainCookiePath(domain), JSON.stringify(data), 'utf8');
    } catch {
        // ignore
    }
}

async function deleteFileCookieCache(domain) {
    try {
        await fs.unlink(getDomainCookiePath(domain));
    } catch {
        // ignore
    }
}

async function tryAcquireDomainLock(domain) {
    if (!domain) return { acquired: false, release: null };
    await ensureLockDir();
    const lockPath = getDomainLockPath(domain);
    try {
        const handle = await fs.open(lockPath, 'wx');
        await handle.close();
        return {
            acquired: true,
            release: async () => {
                try { await fs.unlink(lockPath); } catch { /* ignore */ }
            }
        };
    } catch {
        return { acquired: false, release: null };
    }
}

async function waitForDomainLock(domain) {
    if (!domain) return false;
    const start = Date.now();
    const lockPath = getDomainLockPath(domain);
    while (Date.now() - start < FLARE_LOCK_WAIT_MS) {
        try {
            const stat = await fs.stat(lockPath);
            if (Date.now() - stat.mtimeMs > FLARE_LOCK_TTL) {
                await fs.unlink(lockPath);
                return false;
            }
        } catch {
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return true;
}

async function getCfHeadersForUrl(url) {
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    const cached = await getCachedCfCookies(domain);
    if (!cached?.cookies) return null;
    return {
        headers: {
            'User-Agent': cached.userAgent || HUBCLOUD_USER_AGENT,
            'Cookie': cached.cookies
        },
        requiresProxy: Boolean(cached.requiresProxy)
    };
}

async function getOrCreateFlareSession(domain) {
    if (!FLARESOLVERR_URL || !domain) return null;
    const cached = flareSessionCache.get(domain);
    if (cached && (Date.now() - cached.ts) < FLARE_SESSION_TTL) {
        return cached.sessionId;
    }

    const sessionId = `sootio_hubdrive_${domain.replace(/\./g, '_')}`;
    try {
        const list = await axios.post(`${FLARESOLVERR_URL}/v1`, { cmd: 'sessions.list' }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (list.data?.sessions?.includes(sessionId)) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
    } catch {
        // ignore list errors
    }

    try {
        const createBody = {
            cmd: 'sessions.create',
            session: sessionId
        };
        if (shouldUseFlareProxy(`https://${domain}`)) {
            createBody.proxy = { url: FLARESOLVERR_PROXY_URL };
        }
        const create = await axios.post(`${FLARESOLVERR_URL}/v1`, createBody, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (create.data?.status === 'ok') {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
    } catch (error) {
        if (error.response?.data?.message?.includes('already exists')) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
        console.log(`[HubDrive] FlareSolverr session create failed: ${error.message}`);
    }

    return null;
}

/**
 * Internal function that actually calls FlareSolverr
 * @param {string} url - URL to fetch
 * @param {Object} headers - Request headers
 * @returns {Promise<{document: Object, body: string}|null>}
 */
async function _doFlareSolverrRequest(url, headers = {}) {
    // Check if FlareSolverr is available (not overloaded)
    if (!flaresolverrManager.isAvailable()) {
        const status = flaresolverrManager.getStatus();
        console.warn(`[HubDrive] FlareSolverr unavailable: circuit=${status.circuitOpen}, queue=${status.queueDepth}`);
        return { overloaded: true };
    }

    // Acquire rate limit slot
    const slot = await flaresolverrManager.acquireSlot(30000);
    if (!slot.acquired) {
        console.warn(`[HubDrive] Could not acquire FlareSolverr slot: ${slot.reason}`);
        return { overloaded: true };
    }

    console.log(`[HubDrive] Using FlareSolverr to bypass Cloudflare for ${url}`);
    const flareTimeout = Math.max(FLARESOLVERR_TIMEOUT, 30000);
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    const sessionId = await getOrCreateFlareSession(domain);
    const hasSession = Boolean(sessionId);
    const lock = await tryAcquireDomainLock(domain);
    if (!lock.acquired) {
        const waited = await waitForDomainLock(domain);
        const cached = await getCachedCfCookies(domain);
        if (cached?.cookies) {
            console.log(`[HubDrive] Using cookies from another process for ${domain}`);
            slot.release(); // Release rate limit slot
            return {
                useCachedCookies: true,
                cached
            };
        }
        if (waited) {
            console.log(`[HubDrive] Lock wait expired for ${domain}, continuing without lock`);
        }
    }

    const requestOnce = async ({ useProxy = false, useSession = true } = {}) => {
        const requestBody = {
            cmd: 'request.get',
            url,
            maxTimeout: flareTimeout
        };

        if (useSession && sessionId) {
            requestBody.session = sessionId;
        }

        if (!useSession && useProxy && FLARESOLVERR_PROXY_URL) {
            requestBody.proxy = { url: FLARESOLVERR_PROXY_URL };
        }

        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        const solution = response?.data?.solution;
        if (!solution?.response) {
            console.log(`[HubDrive] FlareSolverr returned no response for ${url}`);
            return null;
        }

        const body = solution.response;
        const markers = getCloudflareMarkers(body);
        const blockingMarkers = markers.filter(marker => marker !== 'cloudflare');
        if (blockingMarkers.length > 0) {
            console.log(`[HubDrive] FlareSolverr still blocked for ${url} markers=${blockingMarkers.join('|')}`);
            return { blocked: true };
        }

        const headerUserAgent = headers['User-Agent'] || headers['user-agent'] || HUBCLOUD_USER_AGENT;
        const solverUserAgent = solution.userAgent || headerUserAgent;
        if (domain && solution.cookies) {
            await cacheCfCookies(domain, solution.cookies, solverUserAgent, useProxy);
        }

        console.log(`[HubDrive] FlareSolverr success for ${url} (status: ${solution.status || 'n/a'})`);
        return {
            document: cheerio.load(body),
            body,
            url: solution.url || url,
            statusCode: solution.status,
            usedProxy: useProxy
        };
    };

    try {
        let result = await requestOnce({ useProxy: false, useSession: true });
        if (result?.blocked) {
            // Retry without session to force a new solve
            result = await requestOnce({ useProxy: false, useSession: false });
        }
        if ((result?.blocked || result === null) && FLARESOLVERR_PROXY_URL) {
            // Last resort: try via proxy with a clean session
            result = await requestOnce({ useProxy: true, useSession: false });
        }
        if (result?.blocked || result === null) {
            return null;
        }
        return result;
    } catch (error) {
        console.log(`[HubDrive] FlareSolverr error for ${url}: ${error.message}`);
        // Report timeout to manager to help circuit breaker
        if (error.message.includes('timeout') || error.code === 'ECONNABORTED') {
            flaresolverrManager.reportTimeout();
        } else {
            flaresolverrManager.reportFailure();
        }
        if (hasSession && domain) {
            flareSessionCache.delete(domain);
        }
        return null;
    } finally {
        slot.release(); // Release rate limit slot
        if (lock.acquired) {
            await lock.release();
        }
    }
}

/**
 * Fetch a URL using FlareSolverr to bypass Cloudflare
 * Includes thundering herd protection - only one FlareSolverr call per domain at a time
 * @param {string} url - URL to fetch
 * @param {Object} headers - Request headers
 * @returns {Promise<{document: Object, body: string}|null>}
 */
async function fetchWithFlareSolverr(url, headers = {}) {
    if (!FLARESOLVERR_URL) {
        console.log('[HubDrive] FlareSolverr not configured, cannot bypass Cloudflare');
        return null;
    }

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    // If there's already a FlareSolverr request in progress for this domain, wait for it
    const existingLock = domain ? flareSolverrLocks.get(domain) : null;
    if (existingLock) {
        console.log(`[HubDrive] Waiting for existing FlareSolverr request for ${domain}...`);
        try {
            await existingLock;
            // After waiting, check if we now have cached cookies
            const cached = await getCachedCfCookies(domain);
            if (cached?.cookies) {
                console.log(`[HubDrive] Using cookies from completed FlareSolverr request for ${domain}`);
                // Return a special marker to signal caller should retry with cached cookies
                return { useCachedCookies: true, cached };
            }
            // No cookies found after waiting - attempt our own FlareSolverr request
            console.log(`[HubDrive] No cookies cached after waiting for lock on ${domain}, retrying FlareSolverr`);
        } catch {
            // Lock failed, continue to make our own request
        }
    }

    // Check again for lock - another request might have created one while we were checking cookies
    const newLock = domain ? flareSolverrLocks.get(domain) : null;
    if (newLock) {
        console.log(`[HubDrive] Lock appeared while checking, waiting for ${domain}...`);
        try {
            await newLock;
            const cached = await getCachedCfCookies(domain);
            if (cached?.cookies) {
                console.log(`[HubDrive] Using cookies from completed FlareSolverr request for ${domain}`);
                return { useCachedCookies: true, cached };
            }
            console.log(`[HubDrive] No cookies cached after second wait on ${domain}, retrying FlareSolverr`);
        } catch {
            // continue
        }
    }

    // Create a lock for this domain
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    if (domain) {
        flareSolverrLocks.set(domain, lockPromise);
    }

    try {
        return await _doFlareSolverrRequest(url, headers);
    } finally {
        // Release the lock
        if (domain) {
            flareSolverrLocks.delete(domain);
        }
        resolveLock?.();
    }
}


/**
 * Extracts HubCloud download links
 * @param {string} url - HubCloud URL
 * @param {string} referer - Referer string for labeling
 * @returns {Promise<Array>} Array of extracted links
 */
export async function extractHubCloudLinks(url, referer) {
    // Skip known dead HubCloud domains
    if (isDeadHubcloudDomain(url)) {
        console.log(`[HubCloud] Skipping dead domain: ${url}`);
        return [];
    }

    // Check in-memory cache first
    const cacheKey = `${url}|${referer || ''}`;
    const cached = extractionCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < EXTRACTION_CACHE_TTL) {
        console.log(`[HubCloud] Extraction cache hit (memory) for: ${url}`);
        return cached.data;
    }

    console.log(`Starting HubCloud extraction for: ${url}`);
    const baseUrl = getBaseUrl(url);
    const activeCf = await getCfHeadersForUrl(url);
    let activeHeaders = activeCf?.headers;
    let activeForceProxy = Boolean(activeCf?.requiresProxy);

    return makeRequest(url, { parseHTML: true, headers: activeHeaders || undefined, disableProxy: shouldBypassHttpProxy(url), forceProxy: activeForceProxy })
        .then(async response => {
            let $ = response.document;
            let attemptedProxyFallback = false;
            let cloudflareCleared = false;

            // Check if we're blocked by Cloudflare
            if (isCloudflareChallenge(response.body, response.statusCode)) {
                // If we're not already using a proxy, try a single proxy fallback before FlareSolverr
                if (!activeForceProxy && FLARESOLVERR_PROXY_URL && !attemptedProxyFallback) {
                    attemptedProxyFallback = true;
                    console.log(`[HubCloud] Cloudflare detected - retrying via proxy before FlareSolverr for ${url}`);
                    const proxyResponse = await makeRequest(url, {
                        parseHTML: true,
                        headers: activeHeaders || undefined,
                        disableProxy: false,
                        forceProxy: true
                    });
                    if (proxyResponse && !isCloudflareChallenge(proxyResponse.body, proxyResponse.statusCode)) {
                        $ = proxyResponse.document;
                        activeForceProxy = true;
                        cloudflareCleared = true;
                        console.log(`[HubCloud] Proxy retry succeeded for ${url}`);
                    } else {
                        console.log(`[HubCloud] Proxy retry still blocked for ${url}`);
                    }
                }
                if (!cloudflareCleared) {
                const domain = (() => {
                    try { return new URL(url).hostname; } catch { return null; }
                })();
                if (activeHeaders?.Cookie) {
                    await clearCachedCfCookies(domain);
                }
                const markers = getCloudflareMarkers(response.body);
                console.error(`[HubCloud] Using FlareSolverr reason=challenge-detected status=${response.statusCode || 'n/a'} markers=${markers.join('|') || 'none'} url=${url}`);

                const flareResponse = await fetchWithFlareSolverr(url, {
                    'User-Agent': HUBCLOUD_USER_AGENT
                });

                // Check if FlareSolverr is overloaded
                if (flareResponse?.overloaded) {
                    console.log(`[HubCloud] FlareSolverr overloaded, returning empty results for ${url}`);
                    return [];
                }

                // Check if we should retry with cached cookies (another request completed while we waited)
                if (flareResponse?.useCachedCookies && flareResponse.cached) {
                    console.log(`[HubCloud] Retrying with cached cookies for ${url}`);
                    const retryHeaders = {
                        'User-Agent': flareResponse.cached.userAgent,
                        'Cookie': flareResponse.cached.cookies
                    };
                    const retryResponse = await makeRequest(url, {
                        parseHTML: true,
                        headers: retryHeaders,
                        disableProxy: shouldBypassHttpProxy(url),
                        forceProxy: Boolean(flareResponse.cached.requiresProxy)
                    });
                    if (retryResponse && !isCloudflareChallenge(retryResponse.body, retryResponse.statusCode)) {
                        $ = retryResponse.document;
                        activeHeaders = retryHeaders;
                        activeForceProxy = Boolean(flareResponse.cached.requiresProxy);
                        console.log(`[HubCloud] Retry with cached cookies successful for ${url}`);
                    } else {
                        console.log(`[HubCloud] Retry with cached cookies still blocked for ${url}`);
                        // Try proxy once if not already attempted
                        if (!activeForceProxy && FLARESOLVERR_PROXY_URL && !attemptedProxyFallback) {
                            attemptedProxyFallback = true;
                            console.log(`[HubCloud] Cached-cookie retry blocked - retrying via proxy for ${url}`);
                            const proxyResponse = await makeRequest(url, {
                                parseHTML: true,
                                headers: retryHeaders,
                                disableProxy: false,
                                forceProxy: true
                            });
                            if (proxyResponse && !isCloudflareChallenge(proxyResponse.body, proxyResponse.statusCode)) {
                                $ = proxyResponse.document;
                                activeHeaders = retryHeaders;
                                activeForceProxy = true;
                                cloudflareCleared = true;
                                console.log(`[HubCloud] Proxy retry succeeded after cached-cookie block for ${url}`);
                            } else {
                                console.log(`[HubCloud] Proxy retry still blocked after cached-cookie block for ${url}`);
                                throw new Error('Cloudflare challenge could not be bypassed');
                            }
                        } else {
                        throw new Error('Cloudflare challenge could not be bypassed');
                        }
                    }
                } else if (flareResponse && flareResponse.document) {
                    $ = flareResponse.document;
                    const updatedCf = await getCfHeadersForUrl(url);
                    activeHeaders = updatedCf?.headers;
                    activeForceProxy = Boolean(updatedCf?.requiresProxy);
                    console.log(`[HubCloud] FlareSolverr bypass successful for ${url}`);
                } else {
                    console.log(`[HubCloud] FlareSolverr bypass failed for ${url}, cannot extract links`);
                    throw new Error('Cloudflare challenge could not be bypassed');
                }
                }
            }

            console.log(`Got HubCloud page, looking for download element...`);

            // Check if this is already a hubcloud.php or gamerxyt.com page
            let href;
            if (url.includes('hubcloud.php') || url.includes('gamerxyt.com')) {
                // If it's already a gamerxyt/hubcloud.php page, use it directly
                href = url;
                console.log(`Already a hubcloud.php/gamerxyt URL: ${href}`);
            } else {
                // Try to find the download link - new structure uses id="download"
                console.log('Looking for download button on page...');
                const downloadElement = $('a#download, a[id="download"]');
                const rawHref = downloadElement.attr('href');

                // Helper to build absolute URLs from relative paths
                const toAbsoluteUrl = (rawUrl) => {
                    if (!rawUrl) return '';
                    return rawUrl.startsWith('http')
                        ? rawUrl
                        : `${baseUrl.replace(/\/$/, '')}/${rawUrl.replace(/^\//, '')}`;
                };

                if (rawHref) {
                    href = rawHref.startsWith('http') ? rawHref : `${baseUrl.replace(/\/$/, '')}/${rawHref.replace(/^\//, '')}`;
                    console.log(`Found download href with #download: ${href}`);
                } else {
                    console.log('Download element #download not found, trying alternatives...');
                    // Try alternative selectors including hubcloud.one direct links
                    const alternatives = [
                        'a[href*="hubcloud.php"]',
                        'a[href*="gamerxyt.com"]',
                        'a[href*="hubcloud.one"]',
                        '.download-btn',
                        'a[href*="download"]',
                        'a.btn.btn-primary',
                        '.btn[href]',
                        '.fa-file-download.fa-lg',
                        '.btn-success',
                        '.btn-danger',
                        '.btn-secondary'
                    ];
                    let found = false;

                    for (const selector of alternatives) {
                        const altElement = $(selector).first();
                        const altHref = altElement.attr('href');
                        if (altHref) {
                            href = altHref.startsWith('http') ? altHref : `${baseUrl.replace(/\/$/, '')}/${altHref.replace(/^\//, '')}`;
                            console.log(`Found download link with selector ${selector}: ${href}`);
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        // Additional selectors from vega-providers approach
                        const additionalSelectors = [
                            'a[href*="hubcloud.php"]',
                            'a[href*="gamerxyt.com"]',
                            'a[href*="hubcloud.one"]',
                            '.download-btn',
                            'a[href*="download"]',
                            '.btn.btn-primary.btn-user.btn-success1.m-1', // From vega-providers
                            '[onclick*="location.replace"]', // Handle onclick redirects
                            'body[onload*="location.replace"]' // Handle body onload redirects
                        ];

                        for (const selector of additionalSelectors) {
                            const altElement = $(selector).first();
                            const altHref = altElement.attr('href') || altElement.attr('onclick') || null;

                            // Extract URL from onclick if needed
                            if (altHref && altHref.includes('location.replace')) {
                                const match = altHref.match(/location\.replace\(['"]([^'"]+)['"]\)/);
                                if (match) {
                                    href = match[1];
                                    console.log(`Found download link from onclick: ${href}`);
                                    found = true;
                                    break;
                                }
                            } else if (altHref) {
                                href = altHref.startsWith('http') ? altHref : `${baseUrl.replace(/\/$/, '')}/${altHref.replace(/^\//, '')}`;
                                console.log(`Found download link with selector ${selector}: ${href}`);
                                found = true;
                                break;
                            }
                        }
                    }

                    if (!found) {
                        // Try meta refresh redirects
                        const metaRefresh = $('meta[http-equiv="refresh"]').attr('content') || '';
                        const refreshMatch = metaRefresh.match(/url=([^;]+)/i);
                        if (refreshMatch && refreshMatch[1]) {
                            href = toAbsoluteUrl(refreshMatch[1].trim());
                            console.log(`Found download link via meta refresh: ${href}`);
                            found = true;
                        }
                    }

                    if (!found) {
                        // Look for script-based redirects (location.href / location.replace)
                        const scripts = $('script')
                            .map((_, el) => $(el).html() || '')
                            .get();

                        for (const script of scripts) {
                            const match = script.match(/location\.(?:href|replace|assign)\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
                            if (match && match[1]) {
                                href = toAbsoluteUrl(match[1]);
                                console.log(`Found download link via script redirect: ${href}`);
                                found = true;
                                break;
                            }
                        }
                    }

                    if (!found) {
                        // Look for inline onclick handlers with navigation
                        const onclickElements = $('[onclick]')
                            .map((_, el) => $(el).attr('onclick') || '')
                            .get();

                        for (const onclick of onclickElements) {
                            const match = onclick.match(/(?:location\.(?:href|replace|assign)|window\.open)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/i);
                            if (match && match[1]) {
                                href = toAbsoluteUrl(match[1]);
                                console.log(`Found download link via onclick: ${href}`);
                                found = true;
                                break;
                            }
                        }
                    }

                    if (!found) {
                        // Look for data-* attributes that often contain links
                        const dataSelectors = '[data-href],[data-url],[data-link],[data-download],[data-file],[data-clipboard-text]';
                        const dataElements = $(dataSelectors).get();
                        for (const el of dataElements) {
                            const $el = $(el);
                            const dataHref = $el.attr('data-href') ||
                                $el.attr('data-url') ||
                                $el.attr('data-link') ||
                                $el.attr('data-download') ||
                                $el.attr('data-file') ||
                                $el.attr('data-clipboard-text');
                            if (dataHref) {
                                href = toAbsoluteUrl(dataHref);
                                console.log(`Found download link via data-* attribute: ${href}`);
                                found = true;
                                break;
                            }
                        }
                    }

                    if (!found) {
                        // Check for iframe sources that point to download pages
                        const frameSrc = $('iframe[src], frame[src]').first().attr('src');
                        if (frameSrc) {
                            href = toAbsoluteUrl(frameSrc);
                            console.log(`Found download link via iframe src: ${href}`);
                            found = true;
                        }
                    }

                    if (!found) {
                        // Scan HTML for embedded URLs or JS variables (window.location, var url, base64)
                        const html = response.body || '';
                        const candidates = new Set();

                        const addCandidate = (rawValue) => {
                            if (!rawValue) return;
                            const absolute = toAbsoluteUrl(rawValue.trim());
                            const lower = absolute.toLowerCase();
                            if (!absolute || lower === url.toLowerCase()) return;
                            if (lower.startsWith('javascript:') || lower === '#') return;
                            if (lower.includes('mailto:') || lower.includes('whatsapp:') || lower.includes('telegram:')) return;
                            if (/\.(?:css|js|png|jpe?g|gif|webp|svg)(?:$|[?#])/i.test(lower)) return;
                            const looksRelevant = lower.includes('hubcloud') ||
                                lower.includes('hubdrive') ||
                                lower.includes('gamerxyt') ||
                                lower.includes('hubcdn') ||
                                lower.includes('workers.dev') ||
                                lower.includes('pixeldrain') ||
                                lower.includes('/?id=') ||
                                lower.includes('download');
                            if (!looksRelevant) return;
                            candidates.add(absolute);
                        };

                        const directUrlMatches = html.match(/https?:\/\/[^\s"'<>]+/gi) || [];
                        directUrlMatches.forEach(addCandidate);

                        const quotedMatches = html.matchAll(/['"]([^'"]+(?:hubcloud|hubdrive|gamerxyt|hubcdn|workers\.dev|pixeldrain|\/\?id=|download)[^'"]*)['"]/gi);
                        for (const match of quotedMatches) {
                            addCandidate(match[1]);
                        }

                        const navMatches = html.matchAll(/(?:location\.(?:href|replace|assign)|window\.location|document\.location)\s*=?\s*['"]([^'"]+)['"]/gi);
                        for (const match of navMatches) {
                            addCandidate(match[1]);
                        }

                        const varMatches = html.matchAll(/(?:var|let|const)\s+(?:url|link|download)\s*=\s*['"]([^'"]+)['"]/gi);
                        for (const match of varMatches) {
                            addCandidate(match[1]);
                        }

                        const atobMatches = html.matchAll(/atob\(\s*['"]([^'"]+)['"]\s*\)/gi);
                        for (const match of atobMatches) {
                            try {
                                const decoded = base64Decode(match[1]).trim();
                                addCandidate(decoded);
                            } catch {
                                // Ignore invalid base64
                            }
                        }

                        const firstCandidate = candidates.values().next().value;
                        if (firstCandidate) {
                            href = firstCandidate;
                            console.log(`Found download link via HTML scan: ${href}`);
                            found = true;
                        }
                    }

                    if (!found) {
                        // Log all available links for debugging
                        console.log('Could not find download link. Available links on page:');
                        $('a[href]').each((i, elem) => {
                            if (i < 20) {  // Only log first 20 links
                                console.log(`Link ${i + 1}: ${$(elem).attr('href')} (text: ${$(elem).text().trim().substring(0, 50)})`);
                            }
                        });
                        throw new Error('Download element not found with any selector');
                    }
                }
            }

            // If the URL is already a hubcloud.one page, we need to extract video directly from it
            if (href.includes('hubcloud.one')) {
                console.log(`Processing hubcloud.one page directly: ${href}`);
                const nextCf = await getCfHeadersForUrl(href);
                const nextHeaders = nextCf?.headers || activeHeaders || undefined;
                const nextForceProxy = Boolean(nextCf?.requiresProxy) || activeForceProxy;
                return makeRequest(href, { parseHTML: true, headers: nextHeaders, disableProxy: shouldBypassHttpProxy(href), forceProxy: nextForceProxy });
            } else {
                console.log(`Making request to HubCloud download page: ${href}`);
                const nextCf = await getCfHeadersForUrl(href);
                const nextHeaders = nextCf?.headers || activeHeaders || undefined;
                const nextForceProxy = Boolean(nextCf?.requiresProxy) || activeForceProxy;
                return makeRequest(href, { parseHTML: true, headers: nextHeaders, disableProxy: shouldBypassHttpProxy(href), forceProxy: nextForceProxy });
            }
        })
        .then(async response => {
            const $ = response.document;
            const results = [];

            const currentUrl = response.url || url;

            console.log(`Processing HubCloud download page (gamerxyt, hubcloud.php, or hubcloud.one)...`);

            // Helper function to extract filename from URL
            const getFilenameFromUrl = (url) => {
                try {
                    const urlObj = new URL(url);
                    const pathname = decodeURIComponent(urlObj.pathname);
                    let filename = pathname.split('/').pop();

                    // Special handling for Google User Content URLs which often have random paths
                    if (urlObj.hostname.includes('googleusercontent.com')) {
                        // For Google User Content URLs, try to get filename from query parameters or header details
                        const searchParams = urlObj.searchParams;
                        if (searchParams.has('file')) {
                            filename = searchParams.get('file');
                        } else if (searchParams.has('name')) {
                            filename = searchParams.get('name');
                        } else if (searchParams.has('title')) {
                            filename = searchParams.get('title');
                        }
                        // If still no meaningful filename, return empty so headerDetails can be used
                        if (filename && filename.length < 10) {
                            // Very short filename, probably not meaningful
                            return '';
                        }
                    }

                    // Remove file extension
                    return filename.replace(/\.(mkv|mp4|avi|webm)$/i, '');
                } catch {
                    return '';
                }
            };

            // Normalize raw size text (strip dates/timestamps, keep "<value> <UNIT>")
            const normalizeSizeText = (rawSize) => {
                if (!rawSize) return '';
                const cleaned = rawSize.replace(/\s+/g, ' ').trim();
                const match = cleaned.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB|KB)/i);
                if (match) {
                    return `${match[1]} ${match[2].toUpperCase()}`;
                }
                return cleaned;
            };

            // Extract quality and size information
            const size = normalizeSizeText($('i#size').text() || '');
            const rawHeader = $('div.card-header').text() || $('title').text() || '';
            // Clean up header: remove tabs, newlines, and extra whitespace
            const header = rawHeader.replace(/[\t\n\r]+/g, ' ').trim();
            const quality = getIndexQuality(header);
            const headerDetails = header;
            const headerLabel = cleanTitle(header) || header;

            console.log(`Extracted info - Size: ${size}, Header: ${header}, Quality: ${quality}`);

            const labelExtras = [];
            if (headerLabel) labelExtras.push(`[${headerLabel}]`);
            if (size) labelExtras.push(`[${size}]`);
            const labelExtra = labelExtras.join('');

            // Check if this is a hubcloud.one page - these pages have download buttons, not embedded video players
            // So we should NOT try to extract video directly, just look for download buttons
            if (currentUrl.includes('hubcloud.one')) {
                console.log(`Detected hubcloud.one page - looking for download buttons (these pages don't have embedded video players)...`);
            }

            // Check if this is a gamerxyt page - these pages have direct workers.dev links
            if (currentUrl.includes('gamerxyt.com') || currentUrl.includes('hubcloud.php')) {
                console.log(`Detected gamerxyt/hubcloud.php page - looking for workers.dev/hubcdn.fans links...`);
            }

            // Find ALL download buttons on the page
            // We'll try all buttons and validate which ones support 206
            let downloadButtons = $('a.btn, a[class*="btn"]');
            console.log(`Found ${downloadButtons.length} download buttons (will try all and validate for 206 support)`);

            if (downloadButtons.length === 0) {
                // Try alternative selectors for download buttons
                const altSelectors = ['a.btn', '.btn', 'a[href]'];
                for (const selector of altSelectors) {
                    const altButtons = $(selector);
                    if (altButtons.length > 0) {
                        console.log(`Found ${altButtons.length} buttons with alternative selector: ${selector}`);
                        altButtons.each((index, btn) => {
                            const link = $(btn).attr('href');
                            const text = $(btn).text();
                            console.log(`Button ${index + 1}: ${text} -> ${link}`);
                        });
                        break;
                    }
                }
            }

            // MEMORY OPTIMIZATION: Limit number of buttons to process to avoid memory issues
            const MAX_BUTTONS = parseInt(process.env.MAX_HUBCLOUD_BUTTONS) || 15;
            const buttonsToProcess = downloadButtons.get().slice(0, MAX_BUTTONS);
            if (downloadButtons.length > MAX_BUTTONS) {
                console.log(`[Memory Optimization] Limiting button processing to ${MAX_BUTTONS} (out of ${downloadButtons.length})`);
            }

            // OPTIMIZATION: Process ALL buttons in parallel instead of sequential batches
            // This reduces processing time from ~2-4s to ~0.5-1s
            const BUTTON_BATCH_SIZE = parseInt(process.env.HUBCLOUD_BUTTON_BATCH_SIZE) || 15; // Process up to 15 in parallel
            console.log(`[HubCloud] Processing ${buttonsToProcess.length} buttons in parallel (batch size: ${BUTTON_BATCH_SIZE})`);
            const startTime = Date.now();

            const buttonPromises = buttonsToProcess.slice(0, BUTTON_BATCH_SIZE).map(async (button, index) => {
                const $button = $(button);
                let link = $button.attr('href');
                const text = $button.text().trim();
                const buttonId = $button.attr('id') || '';
                const buttonStyle = $button.attr('style') || '';

                console.log(`Processing button ${index + 1}: "${text}" -> ${link} (id: ${buttonId})`);

                if (!link || link.startsWith('javascript:') || link === '#' || link === '') {
                    console.log(`Button ${index + 1} has invalid link, skipping`);
                    return null;
                }

                // Detect server type and assign priority
                let serverType = 'other';
                let priority = 0;

                // Server-specific detection based on vega-providers approach
                if (link.includes('.dev') && !link.includes('/?id=')) {
                    serverType = 'Cf Worker';
                    priority = 75;
                    console.log(`Button ${index + 1} identified as Cf Worker (priority: 75)`);
                }
                // Pixeldrain
                else if (link.includes('pixeld')) {
                    try {
                        if (!link.includes('api')) {
                            const token = link.split('/').pop();
                            const baseUrl = link.split('/').slice(0, -2).join('/');
                            link = `${baseUrl}/api/file/${token}?download`;
                        }
                    } catch (err) {
                        console.log(`Error processing Pixeldrain URL: ${err.message}`);
                        // Continue with original link if processing fails
                    }
                    serverType = 'Pixeldrain';
                    priority = 95;
                    console.log(`Button ${index + 1} identified as Pixeldrain (priority: 95)`);
                }
                // Hubcloud redirects
                else if (link.includes('hubcloud') || link.includes('/?id=')) {
                    serverType = 'HubCloud';
                    priority = 85;
                    console.log(`Button ${index + 1} identified as HubCloud (priority: 85)`);
                }
                // Cloudflare Storage
                else if (link.includes('cloudflarestorage')) {
                    serverType = 'CfStorage';
                    priority = 80;
                    console.log(`Button ${index + 1} identified as CfStorage (priority: 80)`);
                }
                // FastDL
                else if (link.includes('fastdl') || link.includes('fsl.')) {
                    serverType = 'FastDl';
                    priority = 90;
                    console.log(`Button ${index + 1} identified as FastDl (priority: 90)`);
                }
                // HubCDN
                else if (link.includes('hubcdn') && !link.includes('/?id=')) {
                    serverType = 'HubCdn';
                    priority = 85;
                    console.log(`Button ${index + 1} identified as HubCdn (priority: 85)`);
                }
                // FSL V2 - id="s3" with specific background color
                else if (buttonId === 's3' || buttonStyle.includes('#2d50e2') || text.includes('FSLv2') || text.includes('FSL V2')) {
                    serverType = 'FSL V2';
                    priority = 100;
                    console.log(`Button ${index + 1} identified as FSL V2 (priority: 100)`);
                }
                // FSL - id="fsl"
                else if (buttonId === 'fsl' || text.includes('FSL Server')) {
                    serverType = 'FSL';
                    priority = 90;
                    console.log(`Button ${index + 1} identified as FSL (priority: 90)`);
                }
                // Mega
                else if (text.toLowerCase().includes('mega') || link.includes('mega.nz') || link.includes('mega.co') || link.includes('mega.io')) {
                    serverType = 'Mega';
                    priority = 80;
                    console.log(`Button ${index + 1} identified as Mega (priority: 80)`);
                }
                // PixelServer
                else if (text.includes('PixelServer') || text.includes('PixelDrain') || link.includes('pixeldrain')) {
                    serverType = 'PixelServer';
                    priority = 70;
                    console.log(`Button ${index + 1} identified as PixelServer (priority: 70)`);
                }
                // R2 storage
                else if (link.includes('r2.dev')) {
                    serverType = 'R2';
                    priority = 88;
                    console.log(`Button ${index + 1} identified as R2 (priority: 88)`);
                }
                else {
                    console.log(`Button ${index + 1} is generic server (priority: 0)`);
                    // Default server type based on hostname if it's a video file
                    if (link.includes('.mkv') || link.includes('.mp4')) {
                        serverType = link
                            .match(/^(?:https?:\/\/)?(?:www\.)?([^\/]+)/i)?.[1]
                            ?.replace(/\./g, ' ') || 'Unknown';
                        priority = 60;
                        console.log(`Button ${index + 1} server type set from hostname: ${serverType} (priority: 60)`);
                    }
                }

                // Check for pixel.hubcdn.fans links - these redirect to googleusercontent.com
                // SKIP these completely as they lead to googleusercontent
                if (link.includes('pixel.hubcdn.fans') || link.includes('pixel.rohitkiskk.workers.dev')) {
                    console.log(`Button ${index + 1} is pixel.hubcdn.fans link - SKIPPING (leads to googleusercontent.com)`);
                    return null;
                }

                // Check for direct workers.dev or hubcdn.fans links from gamerxyt.com
                if (link.includes('workers.dev') || link.includes('hubcdn.fans')) {
                    // Keep workers.dev links even if they end in .zip - they're often direct video links with obfuscated names
                    // We'll validate 206 support later
                    if (!link.includes('workers.dev') && link.toLowerCase().endsWith('.zip')) {
                        console.log(`Button ${index + 1} is a ZIP file, skipping`);
                        return null;
                    }

                    console.log(`Button ${index + 1} is direct workers.dev/hubcdn link`);
                    return {
                        name: `${referer} ${serverType} ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size,
                        priority: priority,
                        serverType: serverType
                    };
                }

                const buttonBaseUrl = getBaseUrl(link);

                if (text.includes('FSL Server') || serverType === 'FSL' || serverType === 'FSL V2') {
                    console.log(`Button ${index + 1} is FSL Server`);
                    return {
                        name: `${referer} [${serverType}] ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size,
                        priority: priority,
                        serverType: serverType
                    };
                } else if (text.includes('Download File')) {
                    console.log(`Button ${index + 1} is Download File`);
                    return {
                        name: `${referer} ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size,
                        priority: priority,
                        serverType: serverType
                    };
                } else if (text.includes('BuzzServer')) {
                    console.log(`Button ${index + 1} is BuzzServer, following redirect...`);
                    try {
                        // Handle BuzzServer redirect
                        const response = await makeRequest(`${link}/download`, {
                            parseHTML: false,
                            allowRedirects: false,
                            headers: { 'Referer': link },
                            disableProxy: shouldBypassHttpProxy(`${link}/download`)
                        });

                        const redirectUrl = response.headers['hx-redirect'] || response.headers['location'];
                        if (redirectUrl) {
                            console.log(`BuzzServer redirect found: ${redirectUrl}`);
                            // Use URL constructor to properly handle both absolute and relative URLs
                            const finalUrl = new URL(redirectUrl, buttonBaseUrl).href;
                            return {
                                name: `${referer} [BuzzServer] ${labelExtra}`,
                                title: getFilenameFromUrl(finalUrl) || headerDetails,
                                url: finalUrl,
                                quality: quality,
                                size: size,
                                priority: priority,
                                serverType: serverType
                            };
                        } else {
                            console.log(`BuzzServer redirect not found`);
                            return null;
                        }
                    } catch (err) {
                        console.log(`BuzzServer redirect failed: ${err.message}`);
                        return null;
                    }
                } else if (link.includes('pixeldra')) {
                    console.log(`Button ${index + 1} is Pixeldrain`);
                    // Convert PixelDrain URLs from /u/ID to /api/file/ID?download
                    let pixelUrl = link;
                    try {
                        const pixelMatch = link.match(/pixeldrain\.[^/]+\/u\/([a-zA-Z0-9]+)/);
                        if (pixelMatch) {
                            pixelUrl = `https://pixeldrain.dev/api/file/${pixelMatch[1]}?download`;
                            console.log(`Converted PixelDrain URL: ${link} -> ${pixelUrl}`);
                        }
                    } catch (err) {
                        console.log(`Error processing Pixeldrain link: ${err.message}`);
                        // Continue with original link if conversion fails
                        pixelUrl = link;
                    }
                    return {
                        name: `${serverType} ${labelExtra}`,
                        title: headerDetails,
                        url: pixelUrl,
                        quality: quality,
                        size: size,
                        priority: priority,
                        serverType: serverType
                    };
                } else if (text.includes('S3 Server')) {
                    console.log(`Button ${index + 1} is S3 Server`);
                    return {
                        name: `${referer} S3 Server ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size,
                        priority: priority,
                        serverType: serverType
                    };
                } else if (text.includes('10Gbps')) {
                    console.log(`Button ${index + 1} is 10Gbps server - attempting redirect resolution...`);
                    let currentLink = link;
                    let redirectCount = 0;
                    const maxRedirects = 3;

                    while (redirectCount < maxRedirects) {
                        const response = await makeRequest(currentLink, {
                            parseHTML: false,
                            allowRedirects: false,
                            disableProxy: shouldBypassHttpProxy(currentLink),
                            forceProxy: activeForceProxy
                        });
                        const redirectUrl = response.headers['location'];
                        if (!redirectUrl) {
                            console.log(`10Gbps: No redirect on attempt ${redirectCount + 1}`);
                            break;
                        }
                        const resolved = new URL(redirectUrl, currentLink).href;
                        if (resolved.includes('link=')) {
                            const finalLink = resolved.split('link=')[1];
                            return {
                                name: `10Gbps [Download] ${labelExtra}`,
                                title: getFilenameFromUrl(finalLink) || headerDetails,
                                url: finalLink,
                                quality: quality,
                                size: size,
                                priority: priority,
                                serverType: serverType
                            };
                        }
                        currentLink = resolved;
                        redirectCount++;
                    }

                    console.log(`10Gbps: Redirect chain incomplete, falling back to original link`);
                    return {
                        name: `${referer} 10Gbps ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        size: size,
                        priority: priority,
                        serverType: serverType
                    };
                } else if (link.includes('pixeldrain.dev') || link.includes('pixeldrain.com')) {
                    console.log(`Button ${index + 1} is PixelDrain link`);
                    // Convert PixelDrain URLs from /u/ID to /api/file/ID?download
                    let pixelUrl = link;
                    try {
                        const pixelMatch = link.match(/pixeldrain\.[^/]+\/u\/([a-zA-Z0-9]+)/);
                        if (pixelMatch) {
                            pixelUrl = `https://pixeldrain.dev/api/file/${pixelMatch[1]}?download`;
                            console.log(`Converted PixelDrain URL: ${link} -> ${pixelUrl}`);
                        }
                    } catch (err) {
                        console.log(`Error processing PixelDrain link: ${err.message}`);
                        // Continue with original link if conversion fails
                        pixelUrl = link;
                    }
                    return {
                        name: `${referer} ${serverType} ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: pixelUrl,
                        quality: quality,
                        size: size,
                        priority: priority,
                        serverType: serverType
                    };
                } else if (link.includes('mega.nz') || link.includes('mega.co') || link.includes('mega.io') || link.includes('mega.blockxpiracy') || text.toLowerCase().includes('mega')) {
                    console.log(`Button ${index + 1} is Mega link, checking if it redirects to transfer.it...`);
                    try {
                        // Check where Mega link redirects to
                        const megaResponse = await makeRequest(link, {
                            parseHTML: true,
                            allowRedirects: true,
                            disableProxy: shouldBypassHttpProxy(link)
                        });

                        const finalUrl = megaResponse.finalUrl || link;

                        // If it redirects to transfer.it, skip it (transfer.it requires JavaScript)
                        if (finalUrl.includes('transfer.it')) {
                            console.log(`Mega link redirects to transfer.it (requires JavaScript), skipping to try next button...`);
                            return null;
                        }

                        const mega$ = megaResponse.document;

                        if (mega$) {
                            // Look for download button with js-download class or direct download links
                            let downloadUrl = null;

                            // Try to find download link in button or data attributes
                            const downloadBtn = mega$('.js-download, button.js-download, a.download');
                            if (downloadBtn.length > 0) {
                                downloadUrl = downloadBtn.attr('data-url') || downloadBtn.attr('data-href') || downloadBtn.attr('href');
                            }

                            // If not found, look for any direct download links
                            if (!downloadUrl) {
                                mega$('a[href]').each((_, el) => {
                                    const href = mega$(el).attr('href');
                                    if (href && (href.includes('workers.dev') || href.includes('.mkv') || href.includes('.mp4') || href.includes('.avi'))) {
                                        downloadUrl = href;
                                        return false; // break
                                    }
                                });
                            }

                            if (downloadUrl) {
                                console.log(`Mega download URL extracted: ${downloadUrl.substring(0, 100)}...`);
                                return {
                                    name: `${referer} ${serverType} ${labelExtra}`,
                                    title: getFilenameFromUrl(downloadUrl) || headerDetails,
                                    url: downloadUrl,
                                    quality: quality,
                                    size: size,
                                    priority: priority,
                                    serverType: serverType
                                };
                            }
                        }
                    } catch (err) {
                        console.log(`Mega extraction failed: ${err.message}`);
                    }

                    // If extraction failed, return null to try next button
                    console.log(`Mega extraction unsuccessful, trying next button...`);
                    return null;
                } else {
                    console.log(`Button ${index + 1} is generic link`);
                    // Generic link
                    return {
                        name: `${referer} ${labelExtra}`,
                        title: getFilenameFromUrl(link) || headerDetails,
                        url: link,
                        quality: quality,
                        priority: priority,
                        serverType: serverType
                    };
                }
            });

            // OPTIMIZATION: Execute all button processing in parallel
            const allButtonResults = await Promise.all(buttonPromises);
            const validButtonResults = allButtonResults.filter(result => result !== null);

            console.log(`[HubCloud] Button processing completed in ${Date.now() - startTime}ms, found ${validButtonResults.length} valid links`);

            // Sort by priority (highest first)
            validButtonResults.sort((a, b) => (b.priority || 0) - (a.priority || 0));
            console.log(`Sorted links by priority: FSL V2 (100) > FSL (90) > Mega (80) > PixelServer (70) > Others (0)`);

            // Add error handling with fallback to return the initial results if post-processing fails
            try {
                return await Promise.resolve(validButtonResults)
                    .then(results => {
                        // Try to extract direct video URLs from results if they look like hubcloud/hubdrive URLs
                        return Promise.all(results.map(async (result) => {
                            // If the URL is a hubcloud page, try to extract the actual video URL
                            if (result.url && (result.url.includes('hubcloud') || result.url.includes('hubdrive'))) {
                                try {
                                    // Get cached cookies for this domain
                                    const domain = (() => {
                                        try { return new URL(result.url).hostname; } catch { return null; }
                                    })();
                                    const cachedCf = await getCachedCfCookies(domain);
                                    const requestHeaders = {
                                        'User-Agent': cachedCf?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    };
                                    if (cachedCf?.cookies) {
                                        requestHeaders['Cookie'] = cachedCf.cookies;
                                    }

                                    const videoPageRes = await makeRequest(result.url, {
                                        headers: requestHeaders,
                                        disableProxy: shouldBypassHttpProxy(result.url),
                                        forceProxy: Boolean(cachedCf?.requiresProxy)
                                    });

                                    // Skip if we got a Cloudflare challenge (don't call FlareSolverr for each video URL)
                                    if (isCloudflareChallenge(videoPageRes.body, videoPageRes.statusCode)) {
                                        console.log(`[HubCloud] Video page ${result.url} has CF challenge, skipping extraction`);
                                        return result;
                                    }

                                    const videoPageHtml = videoPageRes.body;

                                    // Try to extract video URL from various patterns
                                    const videoUrlPatterns = [
                                        /sources:\s*\[\s*{\s*file:\s*"([^"]+)"/,
                                        /file:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                        /src:\s*"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                        /"file":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                        /"src":"([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/,
                                        /video[^>]*src="([^"]+\.(?:mp4|mkv|avi|webm|m3u8)[^"]*)"/
                                    ];

                                    for (const pattern of videoUrlPatterns) {
                                        const match = videoPageHtml.match(pattern);
                                        if (match && match[1]) {
                                            console.log(`Extracted direct video URL from ${result.url}: ${match[1]}`);
                                            return {
                                                ...result,
                                                url: match[1],
                                                name: result.name + ' [Direct Stream]'
                                            };
                                        }
                                    }

                                    // If no video URL found, return original result
                                    console.log(`No direct video URL found in ${result.url}, using original URL`);
                                    return result;
                                } catch (err) {
                                    console.error(`Error extracting video URL from ${result.url}:`, err.message);
                                    return result;
                                }
                            }
                            return result;
                        }));
                    })
                    .then(async (results) => {
                        console.log(`HubCloud post-processing completed, validating ${results.length} links for 206 support...`);

                        // FILTER OUT unwanted URLs
                        const filteredResults = results.filter(result => {
                            if (!result.url) return false;

                            const urlLower = result.url.toLowerCase();

                            // Filter googleusercontent.com URLs - user requested to never return these
                            if (urlLower.includes('googleusercontent.com')) {
                                console.log(`✗ Filtering out googleusercontent.com link: ${result.url.substring(0, 80)}...`);
                                return false;
                            }

                            // Filter tutorial/dummy videos
                            if (urlLower.includes('v-cloudxt.mp4') ||
                                urlLower.includes('tutorial.mp4') ||
                                urlLower.includes('howto.mp4') ||
                                urlLower.includes('instructions.mp4') ||
                                urlLower.includes('sample.mp4') ||
                                urlLower.includes('demo.mp4')) {
                                console.log(`✗ Filtering out tutorial/dummy video: ${result.url.substring(0, 80)}...`);
                                return false;
                            }

                            // Filter spam/malicious URLs
                            // Note: Exempt workers.dev from base64 check - it's a trusted Cloudflare host that often uses long encoded paths
                            const isTrustedHost = urlLower.includes('workers.dev') || urlLower.includes('hubcdn.fans') || urlLower.includes('pixeldrain');
                            if (urlLower.includes('ampproject.org') ||
                                urlLower.includes('hashhackers.com') ||
                                urlLower.includes('bloggingvector.shop') ||
                                (!isTrustedHost && urlLower.match(/[A-Za-z0-9+/=]{100,}/g) !== null)) { // Excessive base64 (skip for trusted hosts)
                                console.log(`✗ Filtering out spam/suspicious URL: ${result.url.substring(0, 80)}...`);
                                return false;
                            }

                            return true;
                        });

                        console.log(`After filtering: ${filteredResults.length} links remaining (${results.length - filteredResults.length} filtered out)`);

                        // Clear results array to free memory
                        results.length = 0;

                        if (filteredResults.length === 0) {
                            console.log(`No links remaining after filtering googleusercontent.com`);
                            return [];
                        }

                        // OPTIMIZATION: Limit total validations but process ALL in parallel
                        const MAX_VALIDATIONS = parseInt(process.env.MAX_HUBCLOUD_VALIDATIONS) || 10;
                        const resultsToValidate = filteredResults.slice(0, MAX_VALIDATIONS);
                        if (filteredResults.length > MAX_VALIDATIONS) {
                            console.log(`[Memory Optimization] Limiting validation to ${MAX_VALIDATIONS} links (out of ${filteredResults.length})`);
                        }

                        // OPTIMIZATION: Skip validation for known-reliable servers (Pixeldrain, R2, FSL, Workers.dev)
                        const TRUSTED_SERVERS = ['Pixeldrain', 'FSL V2', 'FSL', 'R2', 'FastDl', 'Cf Worker', 'HubCloud'];
                        const trustedResults = resultsToValidate.filter(r => TRUSTED_SERVERS.includes(r.serverType));
                        const untrustedResults = resultsToValidate.filter(r => !TRUSTED_SERVERS.includes(r.serverType));

                        console.log(`[HubCloud] Skipping validation for ${trustedResults.length} trusted servers, validating ${untrustedResults.length} others in parallel`);

                        // OPTIMIZATION: Validate ALL untrusted URLs in parallel (not in batches of 3)
                        const validationStartTime = Date.now();
                        const validationResults = await Promise.all(untrustedResults.map(async (result) => {
                            try {
                                const validation = await validateSeekableUrl(result.url, { requirePartialContent: true, timeout: 3000 }); // Reduced timeout
                                if (validation.isValid) {
                                    return result;
                                } else {
                                    console.log(`✗ ${result.serverType || 'Unknown'} server does not support 206`);
                                    return null;
                                }
                            } catch (err) {
                                console.log(`✗ ${result.serverType || 'Unknown'} validation failed: ${err.message}`);
                                return null;
                            }
                        }));

                        const validatedUntrusted = validationResults.filter(r => r !== null);
                        const validatedUrls = [...trustedResults, ...validatedUntrusted];

                        console.log(`[HubCloud] Validation complete in ${Date.now() - validationStartTime}ms: ${validatedUrls.length} URLs valid (${trustedResults.length} trusted + ${validatedUntrusted.length} validated)`);
                        return validatedUrls;
                    });
            } catch (postProcessingError) {
                console.error(`HubCloud post-processing failed:`, postProcessingError.message);
                console.log(`Falling back to original results...`);
                // Return the original button results if post-processing fails
                return validButtonResults;
            }
        })
        .catch(error => {
            console.error(`HubCloud extraction error for ${url}:`, error.message);
            return [];
        })
        .then(results => {
            // Cache successful results in memory
            if (results && results.length > 0) {
                extractionCache.set(cacheKey, { data: results, ts: Date.now() });
            }
            return results;
        })
        .finally(() => {
            // Force garbage collection hint if available
            if (global.gc) {
                global.gc();
                console.log('[Memory] Garbage collection triggered after HubCloud extraction');
            }
        });
}

/**
 * Extracts HubDrive download links
 * @param {string} url - HubDrive URL
 * @param {number} depth - Current recursion depth
 * @returns {Promise<Array>} Array of extracted links
 */
export function extractHubDriveLinks(url, depth = 0, signal = null) {
    // Prevent infinite recursion at function entry
    if (depth >= MAX_RECURSION_DEPTH) {
        console.log(`HubDrive extraction depth limit reached for ${url}`);
        return Promise.resolve([]);
    }

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    return getCachedCfCookies(domain).then(cachedCf => {
        const headers = cachedCf ? { 'User-Agent': cachedCf.userAgent, 'Cookie': cachedCf.cookies } : undefined;
        return makeRequest(url, { parseHTML: true, signal, headers, disableProxy: shouldBypassHttpProxy(url) })
            .then(async response => {
            let $ = response.document;
            let currentUrl = response.url || url;

            // Check if we're blocked by Cloudflare
            if (isCloudflareChallenge(response.body, response.statusCode)) {
                if (cachedCf) {
                    await clearCachedCfCookies(domain);
                }
                const markers = getCloudflareMarkers(response.body);
                console.error(`[HubDrive] Using FlareSolverr reason=challenge-detected status=${response.statusCode || 'n/a'} markers=${markers.join('|') || 'none'} url=${url}`);

                const flareResponse = await fetchWithFlareSolverr(url, {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                });

                // Check if FlareSolverr is overloaded
                if (flareResponse?.overloaded) {
                    console.log(`[HubDrive] FlareSolverr overloaded, returning empty results for ${url}`);
                    return [];
                }

                // Check if we should retry with cached cookies (another request completed while we waited)
                if (flareResponse?.useCachedCookies && flareResponse.cached) {
                    console.log(`[HubDrive] Retrying with cached cookies for ${url}`);
                    const retryHeaders = {
                        'User-Agent': flareResponse.cached.userAgent,
                        'Cookie': flareResponse.cached.cookies
                    };
                    const retryResponse = await makeRequest(url, { parseHTML: true, signal, headers: retryHeaders, disableProxy: shouldBypassHttpProxy(url) });
                    if (retryResponse && !isCloudflareChallenge(retryResponse.body, retryResponse.statusCode)) {
                        $ = retryResponse.document;
                        currentUrl = retryResponse.url || url;
                        console.log(`[HubDrive] Retry with cached cookies successful for ${url}`);
                    } else {
                        console.log(`[HubDrive] Retry with cached cookies still blocked for ${url}`);
                        throw new Error('Cloudflare challenge could not be bypassed');
                    }
                } else if (flareResponse && flareResponse.document) {
                    $ = flareResponse.document;
                    currentUrl = flareResponse.url || url;
                    console.log(`[HubDrive] FlareSolverr bypass successful for ${url}`);
                } else {
                    console.log(`[HubDrive] FlareSolverr bypass failed for ${url}, cannot extract links`);
                    throw new Error('Cloudflare challenge could not be bypassed');
                }
            }

            // Sometimes the page may have redirected to hubcloud.one already
            // Check if this is a hubcloud.one page by looking for the download element
            console.log(`Processing URL: ${currentUrl}, Original URL: ${url}`);

            const downloadBtn = $('.btn.btn-primary.btn-user.btn-success1.m-1');

            if (!downloadBtn || downloadBtn.length === 0) {
                console.log('Primary download button not found, trying alternative selectors...');

                // Check for hubcloud.one specific elements
                const hubcloudDownload = $('#download');
                if (hubcloudDownload.length > 0 && (currentUrl.includes('hubcloud.one') || currentUrl.includes('gamerxyt.com'))) {
                    console.log('Found download element on hubcloud/gamerxyt page');
                    const href = hubcloudDownload.attr('href') || hubcloudDownload.attr('data-href') || hubcloudDownload.attr('onclick');
                    if (href) {
                        let processedHref = href;
                        // If onclick, extract URL from it
                        if (href.includes('location.href')) {
                            const urlMatch = href.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
                            if (urlMatch) {
                                processedHref = urlMatch[1];
                            }
                        }
                        return processHubDriveLink(processedHref, depth, signal);
                    }
                }

                // Try alternative selectors
                const alternatives = [
                    'a.btn.btn-primary',
                    '.btn-primary',
                    'a[href*="download"]',
                    'a.btn',
                    '#download',
                    '.download-btn',
                    '[href*="hubcloud.php"]',
                    '[href*="gamerxyt.com"]'
                ];

                let foundBtn = null;
                let usedSelector = '';
                for (const selector of alternatives) {
                    foundBtn = $(selector);
                    if (foundBtn.length > 0) {
                        console.log(`Found element with selector: ${selector}`);
                        usedSelector = selector;
                        break;
                    }
                }

                if (!foundBtn || foundBtn.length === 0) {
                    console.log('Traditional download button not found, looking for file hosting service links...');

                    // New structure: page has multiple file hosting options
                    // Look for links to known file hosts
                    const fileHostLinks = [];
                    $('a[href]').each((i, elem) => {
                        const href = $(elem).attr('href');
                        const text = $(elem).text().trim().toLowerCase();

                        // Skip invalid links
                        if (!href ||
                            href.startsWith('whatsapp:') ||
                            href.startsWith('telegram:') ||
                            href.startsWith('https://t.me/share') ||
                            href === '#' ||
                            href.startsWith('#main')) {
                            return;
                        }

                        // Check if link is to a known file host
                        if (href.includes('vcloud') ||
                            href.includes('filebee') ||
                            href.includes('gdtot') ||
                            href.includes('hubdrive') ||
                            href.includes('hubcloud') ||
                            href.includes('gdflix') ||
                            href.includes('dgdrive') ||
                            text.includes('download')) {
                            fileHostLinks.push({ href, text });
                            console.log(`Found file host link ${fileHostLinks.length}: ${href} (text: ${text.substring(0, 50)})`);
                        }
                    });

                    if (fileHostLinks.length === 0) {
                        console.log('Available links on page:');
                        $('a[href]').slice(0, 20).each((i, elem) => {
                            console.log(`Link ${i + 1}: ${$(elem).attr('href')} (text: ${$(elem).text().trim().substring(0, 50)})`);
                        });
                        throw new Error('Download button not found with any selector');
                    }

                    // Prefer VCloud, then others
                    const preferredLink = fileHostLinks.find(link =>
                        link.href.includes('vcloud')
                    ) || fileHostLinks[0];

                    console.log(`Using file host link: ${preferredLink.href}`);
                    return processHubDriveLink(preferredLink.href, depth, signal);
                }

                const href = foundBtn.attr('href');
                if (!href) {
                    throw new Error('Download link not found');
                }

                return processHubDriveLink(href, depth, signal);
            }

            const href = downloadBtn.attr('href');
            if (!href) {
                throw new Error('Download link not found');
            }

            return processHubDriveLink(href, depth, signal);
        })
        .catch(error => {
            console.error('Error extracting HubDrive links:', error.message);
            return [];
        });
    });
}

// Track visited URLs to prevent infinite recursion
const visitedHubDriveUrls = new Set();
const MAX_RECURSION_DEPTH = 3;

/**
 * Processes a HubDrive link
 * @param {string} href - HubDrive link to process
 * @param {number} depth - Current recursion depth
 * @returns {Promise<Array>} Array of extracted links
 */
export function processHubDriveLink(href, depth = 0, signal = null) {
    const hrefLower = href.toLowerCase();

    // Prevent infinite recursion
    if (depth >= MAX_RECURSION_DEPTH) {
        console.log(`HubDrive recursion limit reached (${MAX_RECURSION_DEPTH}) for ${href}, stopping`);
        return Promise.resolve([]);
    }

    // Normalize URL for comparison (remove trailing slashes, query params)
    const normalizedUrl = href.split('?')[0].replace(/\/+$/, '');

    // Check if we've already visited this URL
    if (visitedHubDriveUrls.has(normalizedUrl)) {
        console.log(`HubDrive URL already visited: ${normalizedUrl}, preventing loop`);
        return Promise.resolve([]);
    }

    // Mark URL as visited
    visitedHubDriveUrls.add(normalizedUrl);

    // Clean up old URLs after 5 minutes
    setTimeout(() => {
        visitedHubDriveUrls.delete(normalizedUrl);
    }, 300000);

    // Skip homepage/root URLs that don't have specific file paths
    if (normalizedUrl.match(/^https?:\/\/[^\/]+\/?$/)) {
        console.log(`HubDrive homepage URL skipped: ${normalizedUrl}`);
        return Promise.resolve([]);
    }

    // Check if it's a HubCloud link
    if (hrefLower.includes('hubcloud')) {
        console.log('HubDrive link redirects to HubCloud, processing...');
        return extractHubCloudLinks(href, 'HubDrive');
    }
    // Check if it's a VCloud link - use the VCloud extractor
    else if (hrefLower.includes('vcloud') || hrefLower.includes('gdflix')) {
        console.log('HubDrive link is VCloud/GDFlix, processing through extractor...');
        return processExtractorLinkWithAwait(href, 99);
    }
    // Check if it's FileBee - extract download link
    else if (hrefLower.includes('filebee')) {
        console.log('HubDrive link is FileBee, extracting download link...');
        return extractFileBeeLinks(href, signal);
    }
    // Check if it's DropGalaxy/dgdrive - extract download link
    else if (hrefLower.includes('dgdrive') || hrefLower.includes('dropgalaxy')) {
        console.log('HubDrive link is DropGalaxy, extracting download link...');
        return extractDropGalaxyLinks(href, signal);
    }
    // Check if it's another HubDrive link - recurse with depth tracking
    else if (hrefLower.includes('hubdrive')) {
        console.log(`HubDrive link is another HubDrive page, recursing (depth ${depth + 1})...`);
        return extractHubDriveLinks(href, depth + 1, signal);
    }
    else {
        console.log('HubDrive direct link found');
        // Direct link or other extractor
        return Promise.resolve([{
            name: 'HubDrive',
            title: 'HubDrive',
            url: href,
            quality: 1080
        }]);
    }
}

/**
 * Extracts download links from FileBee
 * @param {string} url - FileBee URL
 * @returns {Promise<Array>} Array of extracted links
 */
export async function extractFileBeeLinks(url, signal = null) {
    console.log(`Starting FileBee extraction for: ${url}`);

    try {
        const response = await makeRequest(url, { parseHTML: true, signal });
        const $ = response.document;

        if (!$) {
            console.log('FileBee: Failed to parse HTML');
            return [];
        }

        // Look for download link in common patterns
        let downloadUrl = null;

        // Try download button
        const downloadBtn = $('.download-btn, .btn-download, a.download, button.download, .js-download');
        if (downloadBtn.length > 0) {
            downloadUrl = downloadBtn.attr('href') || downloadBtn.attr('data-url') || downloadBtn.attr('data-href');
        }

        // Try any link with "download" in href or text
        if (!downloadUrl) {
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().toLowerCase();
                if (href && (href.includes('download') || href.includes('.mkv') || href.includes('.mp4') || text.includes('download'))) {
                    downloadUrl = href;
                    return false; // break
                }
            });
        }

        if (downloadUrl) {
            // Make absolute URL
            try {
                downloadUrl = new URL(downloadUrl, url).href;
            } catch (err) {
                console.log(`FileBee: Failed to construct absolute URL: ${err.message}`);
            }

            console.log(`FileBee download URL extracted: ${downloadUrl.substring(0, 100)}...`);

            const title = $('title').text().trim() || 'FileBee';

            return [{
                name: 'FileBee',
                title: title,
                url: downloadUrl,
                quality: 1080
            }];
        }

        console.log('FileBee: No download link found');
        return [];
    } catch (error) {
        console.error('Error extracting FileBee links:', error.message);
        return [];
    }
}

/**
 * Extracts download links from DropGalaxy
 * @param {string} url - DropGalaxy URL
 * @returns {Promise<Array>} Array of extracted links
 */
export async function extractDropGalaxyLinks(url, signal = null) {
    console.log(`Starting DropGalaxy extraction for: ${url}`);

    try {
        const response = await makeRequest(url, { parseHTML: true, signal });
        const $ = response.document;

        if (!$) {
            console.log('DropGalaxy: Failed to parse HTML');
            return [];
        }

        // Look for download link in common patterns
        let downloadUrl = null;

        // Try download button
        const downloadBtn = $('.download-btn, .btn-download, a.download, button.download, .js-download');
        if (downloadBtn.length > 0) {
            downloadUrl = downloadBtn.attr('href') || downloadBtn.attr('data-url') || downloadBtn.attr('data-href');
        }

        // Try any link with "download" in href or text
        if (!downloadUrl) {
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().toLowerCase();
                if (href && (href.includes('download') || href.includes('.mkv') || href.includes('.mp4') || text.includes('download'))) {
                    downloadUrl = href;
                    return false; // break
                }
            });
        }

        if (downloadUrl) {
            // Make absolute URL
            try {
                downloadUrl = new URL(downloadUrl, url).href;
            } catch (err) {
                console.log(`DropGalaxy: Failed to construct absolute URL: ${err.message}`);
            }

            console.log(`DropGalaxy download URL extracted: ${downloadUrl.substring(0, 100)}...`);

            const title = $('title').text().trim() || 'DropGalaxy';

            return [{
                name: 'DropGalaxy',
                title: title,
                url: downloadUrl,
                quality: 1080
            }];
        }

        console.log('DropGalaxy: No download link found');
        return [];
    } catch (error) {
        console.error('Error extracting DropGalaxy links:', error.message);
        return [];
    }
}

/**
 * Extracts video links from HDStream4u
 * @param {string} url - HDStream4u URL
 * @returns {Promise<Array>} Array of extracted links
 */
export async function extractHDStream4uLinks(url) {
    console.log(`Starting HDStream4u extraction for: ${url}`);

    try {
        const response = await makeRequest(url, { parseHTML: true });
        const $ = response.document;

        // Get title from page
        const title = $('title').text().trim() || 'HDStream4u';
        console.log(`HDStream4u title: ${title}`);

        // Extract file ID from URL or page
        const fileIdMatch = url.match(/\/file\/([a-zA-Z0-9]+)/);
        const fileId = fileIdMatch ? fileIdMatch[1] : null;

        if (!fileId) {
            throw new Error('Could not extract file ID from URL');
        }

        console.log(`HDStream4u file ID: ${fileId}`);

        // Try to find JW Player setup in the page
        const pageHtml = response.body;

        // Look for video sources in the obfuscated JavaScript
        // Pattern 1: Direct m3u8 URLs
        const m3u8Matches = pageHtml.matchAll(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g);
        const m3u8Urls = [...m3u8Matches].map(match => match[0]);

        // Pattern 2: Video sources in player config
        const sourceMatches = pageHtml.matchAll(/["']file["']\s*:\s*["']([^"']+)["']/g);
        const sourceUrls = [...sourceMatches].map(match => match[1]).filter(url =>
            url.includes('.m3u8') || url.includes('.mp4') || url.includes('.mkv')
        );

        const allUrls = [...new Set([...m3u8Urls, ...sourceUrls])];

        if (allUrls.length === 0) {
            console.log('No video URLs found in page, trying API endpoint...');

            // Try common API patterns for video streaming sites
            // Many use /api/source or /dl endpoints
            const apiUrl = `https://hdstream4u.com/api/source/${fileId}`;
            try {
                const apiResponse = await makeRequest(apiUrl, {
                    headers: {
                        'Referer': url,
                        'Origin': 'https://hdstream4u.com'
                    }
                });

                if (apiResponse.body) {
                    const apiData = typeof apiResponse.body === 'string'
                        ? JSON.parse(apiResponse.body)
                        : apiResponse.body;

                    if (apiData.data && Array.isArray(apiData.data)) {
                        // Extract sources from API response
                        return apiData.data.map(source => ({
                            name: 'HDStream4u',
                            url: source.file || source.url,
                            quality: source.label || source.quality || 'auto'
                        }));
                    }
                }
            } catch (apiErr) {
                console.log(`API extraction failed: ${apiErr.message}`);
            }
        }

        if (allUrls.length > 0) {
            console.log(`Found ${allUrls.length} video URL(s) in HDStream4u page`);

            return allUrls.map(videoUrl => {
                // Try to determine quality from URL or title
                let quality = 'auto';
                if (videoUrl.includes('1080') || title.includes('1080')) quality = '1080p';
                else if (videoUrl.includes('720') || title.includes('720')) quality = '720p';
                else if (videoUrl.includes('480') || title.includes('480')) quality = '480p';

                return {
                    name: 'HDStream4u',
                    url: videoUrl,
                    quality
                };
            });
        }

        console.log('No video sources found in HDStream4u page');
        return [];

    } catch (error) {
        console.error(`HDStream4u extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Processes redirect links from 4KHDHub
 * @param {string} url - URL to extract redirect from
 * @returns {Promise<string>} Extracted redirect URL
 */
export function getRedirectLinks(url) {
    return makeRequest(url)
        .then(async response => {
            const doc = response.body;
            const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
            let combinedString = '';
            let match;

            while ((match = regex.exec(doc)) !== null) {
                const extractedValue = match[1] || match[2];
                if (extractedValue) {
                    combinedString += extractedValue;
                }
            }

            try {
                const decodedString = base64Decode(rot13(base64Decode(base64Decode(combinedString))));
                const jsonObject = JSON.parse(decodedString);
                const encodedurl = base64Decode(jsonObject.o || '').trim();
                const data = base64Decode(jsonObject.data || '').trim();
                const wphttp1 = (jsonObject.blog_url || '').trim();

                if (encodedurl) {
                    return Promise.resolve(encodedurl);
                }

                if (wphttp1 && data) {
                    return makeRequest(`${wphttp1}?re=${data}`, { parseHTML: true })
                        .then(resp => resp.document.body.textContent.trim())
                        .catch(() => '');
                }

                return Promise.resolve('');
            } catch (e) {
                console.error('Error processing links:', e.message);
                return Promise.resolve('');
            }
        })
        .catch(error => {
            console.error('Error fetching redirect links:', error.message);
            return Promise.resolve('');
        });
}

/**
 * Extracts streaming links from download links
 * @param {Array<string>} downloadLinks - Array of download links
 * @returns {Promise<Array>} Array of extracted streaming links
 */
export function extractStreamingLinks(downloadLinks) {
    console.log(`Processing ${downloadLinks.length} download links...`);

    // Log the actual links being processed
    downloadLinks.forEach((link, index) => {
        console.log(`Link ${index + 1}: ${link}`);
    });

    // Process all links in parallel with configurable concurrency
    const processLink = async (link, index) => {
        try {
            console.log(`Processing link ${index + 1}: ${link}`);

            // Check if link needs redirect processing
            if (link.toLowerCase().includes('id=')) {
                console.log(`Link ${index + 1} needs redirect processing`);
                const resolvedLink = await getRedirectLinks(link);
                if (resolvedLink) {
                    console.log(`Link ${index + 1} resolved to: ${resolvedLink}`);
                    return await processExtractorLinkWithAwait(resolvedLink, index + 1);
                } else {
                    console.log(`Link ${index + 1} redirect resolution failed`);
                    return null;
                }
            } else {
                return await processExtractorLinkWithAwait(link, index + 1);
            }
        } catch (err) {
            console.error(`Error processing link ${index + 1} (${link}):`, err.message);
            return null;
        }
    };

    // Remove duplicate links before processing to avoid redundant work
    const uniqueDownloadLinks = [...new Set(downloadLinks)];

    // Process all links in parallel using Promise.all for better performance
    return Promise.all(uniqueDownloadLinks.map((link, index) => processLink(link, index)))
        .then(results => {
            const validResults = results.filter(result => result !== null);
            const flatResults = validResults.flat();
            // Filter out .zip files and video-downloads.googleusercontent.com URLs
            const filteredResults = flatResults.filter(link => {
                return link && link.url &&
                       !link.url.toLowerCase().endsWith('.zip') &&
                       !link.url.toLowerCase().includes('video-downloads.googleusercontent.com');
            });
            console.log(`Successfully extracted ${filteredResults.length} streaming links (${flatResults.length - filteredResults.length} .zip files excluded)`);
            return filteredResults;
        });
}

/**
 * Async version of processExtractorLink for use with await
 * @param {string} link - Link to process
 * @param {number} linkNumber - Link number for logging
 * @returns {Promise<Array|null>} Array of extracted links or null
 */
export async function processExtractorLinkWithAwait(link, linkNumber) {
    const linkLower = link.toLowerCase();

    console.log(`Checking extractors for link ${linkNumber}: ${link}`);

    // Import hdhub4uGetStream dynamically to avoid circular dependency
    const { hdhub4uGetStream } = await import('../hdhub4u/extraction.js');

    // Check for hblinks.dad first - scrape page for hubcloud/hubdrive links
    if (linkLower.includes('hblinks.dad')) {
        console.log(`Link ${linkNumber} matched HBLinks extractor (scraping for download links)`);
        try {
            const response = await makeRequest(link, { parseHTML: true });
            const $ = response.document;

            // Extract hubdrive and hubcloud links from the page
            const extractedLinks = [];
            $('a[href]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href && (href.includes('hubdrive') || href.includes('hubcloud'))) {
                    extractedLinks.push(href);
                    console.log(`Found link in HBLinks page: ${href}`);
                }
            });

            if (extractedLinks.length === 0) {
                console.log(`No hubdrive/hubcloud links found in HBLinks page ${link}`);
                return null;
            }

            console.log(`Found ${extractedLinks.length} links in HBLinks page, processing ALL of them...`);

            // Process ALL available links to get all quality options
            const allResults = [];
            for (let i = 0; i < extractedLinks.length; i++) {
                const extractedLink = extractedLinks[i];
                console.log(`Processing HBLinks extracted link ${i + 1}/${extractedLinks.length}: ${extractedLink}`);
                try {
                    const results = await processExtractorLinkWithAwait(extractedLink, linkNumber);
                    if (results && Array.isArray(results)) {
                        allResults.push(...results);
                    }
                } catch (err) {
                    console.error(`Failed to process HBLinks link ${i + 1}: ${err.message}`);
                }
            }

            console.log(`HBLinks processing complete: collected ${allResults.length} total streams from ${extractedLinks.length} links`);
            return allResults.length > 0 ? allResults : null;
        } catch (err) {
            console.error(`HBLinks extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('hubcdn.fans') || linkLower.includes('hubcdn')) {
        console.log(`Link ${linkNumber} matched HubCDN extractor (direct stream extraction)`);
        try {
            const streamResults = await hdhub4uGetStream(link);
            if (streamResults && streamResults.length > 0) {
                // Convert hdhub4uGetStream results to our format
                const convertedLinks = streamResults.map(result => ({
                    name: result.server || 'HubCDN Stream',
                    title: result.server || 'HubCDN Stream',
                    url: result.link,
                    quality: 1080,
                    type: result.type || 'mp4'
                }));
                console.log(`HubCDN extraction completed for link ${linkNumber}:`, convertedLinks);
                return convertedLinks;
            } else {
                console.log(`HubCDN extraction returned no results for link ${linkNumber}`);
                return null;
            }
        } catch (err) {
            console.error(`HubCDN extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('hubdrive')) {
        console.log(`Link ${linkNumber} matched HubDrive extractor`);
        try {
            const links = await extractHubDriveLinks(link);
            console.log(`HubDrive extraction completed for link ${linkNumber}:`, links);
            return links;
        } catch (err) {
            console.error(`HubDrive extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('vcloud.') || linkLower.includes('gdflix') || linkLower.includes('gdlink')) {
        console.log(`Link ${linkNumber} matched GDFlix/VCloud extractor`);
        try {
            const visited = new Set();

            const collectGdflixLinks = async (pageUrl) => {
                if (!pageUrl || visited.has(pageUrl)) return [];
                visited.add(pageUrl);

                const response = await makeRequest(pageUrl, { parseHTML: true });
                const pageHtml = response.body || '';
                const $ = response.document;
                const found = [];

                // Look for JS-assigned hubcloud URL (vcloud style)
                const scriptMatch = pageHtml.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/i);
                if (scriptMatch?.[1]) {
                    try {
                        found.push(new URL(scriptMatch[1], pageUrl).toString());
                    } catch {
                        found.push(scriptMatch[1]);
                    }
                }

                if ($) {
                    $('a[href]').each((_, el) => {
                        const href = $(el).attr('href');
                        if (!href) return;
                        let absolute = href;
                        try {
                            absolute = new URL(href, pageUrl).toString();
                        } catch {
                            // leave as-is
                        }
                        const hrefLower = absolute.toLowerCase();
                        const text = ($(el).text() || '').toLowerCase();

                        // Skip obviously invalid links
                        if (hrefLower.includes('/admin') ||
                            hrefLower.includes('#login') ||
                            hrefLower.endsWith('.fans/') ||
                            hrefLower.endsWith('.zip/') ||
                            hrefLower.endsWith('.one/') ||
                            hrefLower.includes('javascript:') ||
                            href === '#' ||
                            hrefLower.includes('whatsapp:') ||
                            hrefLower.includes('telegram:') ||
                            hrefLower.includes('t.me/share')) {
                            return; // Skip invalid links
                        }

                        // Skip tutorial/dummy videos
                        if (hrefLower.includes('v-cloudxt.mp4') ||
                            hrefLower.includes('tutorial.mp4') ||
                            hrefLower.includes('howto.mp4') ||
                            hrefLower.includes('instructions.mp4') ||
                            hrefLower.includes('sample.mp4') ||
                            hrefLower.includes('demo.mp4')) {
                            return; // Skip tutorial videos
                        }

                        if (hrefLower.includes('hubcloud') ||
                            hrefLower.includes('hubdrive') ||
                            hrefLower.includes('gamerxyt') ||
                            hrefLower.includes('technorozen') ||
                            hrefLower.includes('vcloud.') ||
                            hrefLower.includes('hubcdn') ||
                            hrefLower.includes('workers.dev')) {
                            found.push(absolute);
                        } else if (hrefLower.includes('pixeldrain')) {
                            found.push(absolute);
                        } else if (hrefLower.includes('/zfile/')) {
                            found.push(absolute);
                        } else if (text.includes('instant dl') || hrefLower.includes('instant.')) {
                            found.push(absolute);
                        }
                    });
                }

                // Follow zfile intermediates to surface real hosting links
                const zfileLinks = found.filter(u => u.includes('/zfile/'));
                for (const zLink of zfileLinks) {
                    const extra = await collectGdflixLinks(zLink);
                    found.push(...extra);
                }

                return found;
            };

            const candidateLinks = await collectGdflixLinks(link);
            if (!candidateLinks.length) {
                console.log(`GDFlix extractor could not find hosting URLs in ${link}`);
                return null;
            }

            const unique = Array.from(new Set(candidateLinks));
            console.log(`GDFlix found ${unique.length} candidate link(s)`);

            const streams = [];

            for (const candidate of unique) {
                const lower = candidate.toLowerCase();
                if (lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('gamerxyt') || lower.includes('vcloud')) {
                    try {
                        const hubStreams = await extractHubCloudLinks(candidate, 'GDFlix');
                        if (hubStreams?.length) {
                            streams.push(...hubStreams);
                            continue;
                        }
                    } catch (err) {
                        console.error(`GDFlix hubcloud extraction failed for ${candidate}: ${err.message}`);
                    }
                }

                if (lower.includes('pixeldrain')) {
                    const match = candidate.match(/pixeldrain[^/]*\/u\/([A-Za-z0-9]+)/);
                    const fileId = match?.[1];
                    const direct = fileId ? `https://pixeldrain.dev/api/file/${fileId}?download` : candidate;
                    streams.push({
                        name: 'PixelDrain',
                        title: 'PixelDrain',
                        url: direct,
                        quality: 1080
                    });
                    continue;
                }

                // Fall back to treating other links as direct/redirects
                streams.push({
                    name: 'GDFlix',
                    title: 'GDFlix',
                    url: candidate,
                    quality: 1080
                });
            }

            if (!streams.length) {
                console.log(`GDFlix extraction produced no streams for ${link}`);
                return null;
            }

            console.log(`GDFlix extraction completed for link ${linkNumber} with ${streams.length} stream(s)`);
            return streams;
        } catch (err) {
            console.error(`GDFlix/VCloud extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('hubcloud')) {
        console.log(`Link ${linkNumber} matched HubCloud extractor`);
        try {
            const links = await extractHubCloudLinks(link, 'HubCloud');
            console.log(`HubCloud extraction completed for link ${linkNumber}:`, links);
            return links;
        } catch (err) {
            console.error(`HubCloud extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('gadgetsweb.xyz') || linkLower.includes('gadgetsweb')) {
        console.log(`Link ${linkNumber} matched GadgetsWeb extractor (encrypted redirect)`);
        try {
            const streamResults = await hdhub4uGetStream(link);
            if (streamResults && streamResults.length > 0) {
                const convertedLinks = streamResults.map(result => ({
                    name: result.server || 'HDHub4u Stream',
                    title: result.server || 'HDHub4u Stream',
                    url: result.link,
                    quality: 1080,
                    type: result.type || 'mp4'
                }));
                console.log(`GadgetsWeb extraction completed for link ${linkNumber}:`, convertedLinks);
                return convertedLinks;
            }

            console.log(`GadgetsWeb extraction returned no results for link ${linkNumber}`);
            return null;
        } catch (err) {
            console.error(`GadgetsWeb extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else if (linkLower.includes('hdstream4u.com')) {
        console.log(`Link ${linkNumber} matched HDStream4u extractor`);
        try {
            const links = await extractHDStream4uLinks(link);
            console.log(`HDStream4u extraction completed for link ${linkNumber}:`, links);
            return links;
        } catch (err) {
            console.error(`HDStream4u extraction failed for link ${linkNumber} (${link}):`, err.message);
            return null;
        }
    } else {
        console.log(`No extractor matched for link ${linkNumber}: ${link}`);
        // Try to extract any direct streaming URLs from the link
        if (link.includes('http') && (link.includes('.mp4') || link.includes('.mkv') || link.includes('.avi') || link.includes('.webm') || link.includes('.m3u8'))) {
            console.log(`Link ${linkNumber} appears to be a direct video link`);
            return [{
                name: 'Direct Link',
                url: link,
                quality: 1080
            }];
        } else {
            return null;
        }
    }
}

/**
 * Promise-based version of processExtractorLink (legacy)
 * @param {string} link - Link to process
 * @param {Function} resolve - Promise resolve function
 * @param {number} linkNumber - Link number for logging
 */
export function processExtractorLink(link, resolve, linkNumber) {
    processExtractorLinkWithAwait(link, linkNumber)
        .then(resolve)
        .catch(err => {
            console.error(`Error in processExtractorLink:`, err);
            resolve(null);
        });
}

export const __test__ = {
    getCachedCfCookies,
    cacheCfCookies,
    clearCachedCfCookies,
    getOrCreateFlareSession,
    HUBCLOUD_USER_AGENT
};
