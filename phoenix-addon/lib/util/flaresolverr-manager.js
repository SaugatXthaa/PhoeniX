// lib/util/flaresolverr-manager.js
// Faithful port of sootio-stremio-addon/lib/util/flaresolverr-manager.js
// Provides rate limiting, circuit breaker, cookie cache, and overload protection

import axios from 'axios';

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || process.env.FLARESOLVERR_ENDPOINT || '';
const MAX_CONCURRENT = parseInt(process.env.FLARESOLVERR_MAX_CONCURRENT, 10) || 2;
const QUEUE_MAX_DEPTH = parseInt(process.env.FLARESOLVERR_QUEUE_MAX_DEPTH, 10) || 10;
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.FLARESOLVERR_CIRCUIT_THRESHOLD, 10) || 3;
const CIRCUIT_BREAKER_RESET_MS = parseInt(process.env.FLARESOLVERR_CIRCUIT_RESET_MS, 10) || 120000;
const TIMEOUT_THRESHOLD_MS = parseInt(process.env.FLARESOLVERR_TIMEOUT_THRESHOLD_MS, 10) || 30000;

const PER_IP_HOURLY_LIMIT = parseInt(process.env.FLARESOLVERR_PER_IP_HOURLY_LIMIT, 10) || 30;
const IP_TRACKING_WINDOW_MS = 60 * 60 * 1000;
const DIRECT_FIRST_DOMAINS = new Set([
    'hubcloud.foo', 'hubcloud.fyi', 'hubcloud.one', 'hubcloud.lol',
    'hubdrive.dad', 'hubdrive.co', 'hubcdn.fans'
]);

let activeCalls = 0;
const pendingQueue = [];
let circuitFailures = 0;
let circuitOpenedAt = null;
let lastQueueWarningTime = 0;
let consecutiveSlowResponses = 0;
let lastResponseTime = 0;

const ipRequestCounts = new Map();
let lastIpCleanup = Date.now();

const domainCookieCache = new Map();
const COOKIE_CACHE_TTL = parseInt(process.env.FLARESOLVERR_COOKIE_TTL_MS, 10) || 30 * 60 * 1000;

const metrics = {
    totalCalls: 0,
    directSuccesses: 0,
    flaresolverrCalls: 0,
    flaresolverrSuccesses: 0,
    flaresolverrFailures: 0,
    circuitBreakerTrips: 0,
    queueOverflows: 0,
    cacheHits: 0
};

export function getStatus() {
    return {
        activeCalls,
        queueDepth: pendingQueue.length,
        circuitOpen: isCircuitOpen(),
        metrics: { ...metrics }
    };
}

export function isAvailable(clientIp = null) {
    if (!FLARESOLVERR_URL) return false;
    if (isCircuitOpen()) return false;
    if (pendingQueue.length >= QUEUE_MAX_DEPTH) return false;
    if (clientIp && isIpRateLimited(clientIp)) return false;
    return true;
}

export function isIpRateLimited(ip) {
    if (!ip || PER_IP_HOURLY_LIMIT <= 0) return false;
    cleanupExpiredIpCounts();
    const record = ipRequestCounts.get(ip);
    if (!record) return false;
    const now = Date.now();
    if (now - record.windowStart >= IP_TRACKING_WINDOW_MS) {
        ipRequestCounts.delete(ip);
        return false;
    }
    return record.count >= PER_IP_HOURLY_LIMIT;
}

export function recordIpRequest(ip) {
    if (!ip || PER_IP_HOURLY_LIMIT <= 0) return;
    const now = Date.now();
    const record = ipRequestCounts.get(ip);
    if (!record || (now - record.windowStart >= IP_TRACKING_WINDOW_MS)) {
        ipRequestCounts.set(ip, { count: 1, windowStart: now });
    } else {
        record.count++;
    }
}

export function getIpRemainingRequests(ip) {
    if (!ip || PER_IP_HOURLY_LIMIT <= 0) return -1;
    const record = ipRequestCounts.get(ip);
    if (!record) return PER_IP_HOURLY_LIMIT;
    const now = Date.now();
    if (now - record.windowStart >= IP_TRACKING_WINDOW_MS) return PER_IP_HOURLY_LIMIT;
    return Math.max(0, PER_IP_HOURLY_LIMIT - record.count);
}

function cleanupExpiredIpCounts() {
    const now = Date.now();
    if (now - lastIpCleanup < 5 * 60 * 1000) return;
    lastIpCleanup = now;
    for (const [ip, record] of ipRequestCounts.entries()) {
        if (now - record.windowStart >= IP_TRACKING_WINDOW_MS) {
            ipRequestCounts.delete(ip);
        }
    }
}

function isCircuitOpen() {
    if (circuitOpenedAt === null) return false;
    const elapsed = Date.now() - circuitOpenedAt;
    if (elapsed > CIRCUIT_BREAKER_RESET_MS) {
        circuitOpenedAt = null;
        circuitFailures = 0;
        console.log('[FlareSolverr Manager] Circuit breaker reset');
        return false;
    }
    return true;
}

function recordFailure() {
    circuitFailures++;
    if (circuitFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpenedAt = Date.now();
        metrics.circuitBreakerTrips++;
        console.warn(`[FlareSolverr Manager] Circuit breaker OPENED after ${circuitFailures} failures`);
    }
}

function recordSuccess() {
    circuitFailures = Math.max(0, circuitFailures - 1);
    consecutiveSlowResponses = 0;
}

function recordSlowResponse(durationMs) {
    lastResponseTime = durationMs;
    if (durationMs > TIMEOUT_THRESHOLD_MS) {
        consecutiveSlowResponses++;
        console.warn(`[FlareSolverr Manager] Slow response: ${durationMs}ms (consecutive: ${consecutiveSlowResponses})`);
        if (consecutiveSlowResponses >= CIRCUIT_BREAKER_THRESHOLD) {
            circuitOpenedAt = Date.now();
            metrics.circuitBreakerTrips++;
            console.warn(`[FlareSolverr Manager] Circuit breaker OPENED due to slow responses`);
        }
    } else {
        consecutiveSlowResponses = Math.max(0, consecutiveSlowResponses - 1);
    }
}

export function reportFailure() { recordFailure(); }
export function reportTimeout() {
    consecutiveSlowResponses++;
    recordFailure();
}

export function getCachedCookies(domain) {
    const cached = domainCookieCache.get(domain);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > COOKIE_CACHE_TTL) {
        domainCookieCache.delete(domain);
        return null;
    }
    metrics.cacheHits++;
    return cached;
}

export function cacheCookies(domain, cookies, userAgent, directAccessOk = false) {
    domainCookieCache.set(domain, {
        cookies, userAgent, timestamp: Date.now(), directAccessOk
    });
    console.log(`[FlareSolverr Manager] Cached cookies for ${domain} (directOk: ${directAccessOk})`);
}

export function markDirectAccessOk(domain) {
    const cached = domainCookieCache.get(domain);
    if (cached) {
        cached.directAccessOk = true;
        cached.timestamp = Date.now();
    } else {
        domainCookieCache.set(domain, {
            cookies: '', userAgent: '', timestamp: Date.now(), directAccessOk: true
        });
    }
    metrics.directSuccesses++;
}

export function clearCachedCookies(domain) {
    domainCookieCache.delete(domain);
}

export function shouldTryDirectFirst(domain) {
    const cached = getCachedCookies(domain);
    if (cached?.directAccessOk) return true;
    return DIRECT_FIRST_DOMAINS.has(domain);
}

export async function acquireSlot(timeout = 30000, clientIp = null) {
    metrics.totalCalls++;

    if (isCircuitOpen()) {
        console.warn('[FlareSolverr Manager] Circuit breaker is OPEN, rejecting request');
        return { acquired: false, release: () => {}, reason: 'circuit_open' };
    }

    if (clientIp && isIpRateLimited(clientIp)) {
        const remaining = getIpRemainingRequests(clientIp);
        console.warn(`[FlareSolverr Manager] IP ${clientIp} rate limited (${remaining} remaining this hour)`);
        return { acquired: false, release: () => {}, reason: 'ip_rate_limited', remaining };
    }

    if (pendingQueue.length >= QUEUE_MAX_DEPTH) {
        const now = Date.now();
        if (now - lastQueueWarningTime > 5000) {
            console.warn(`[FlareSolverr Manager] Queue full (${pendingQueue.length}/${QUEUE_MAX_DEPTH}), rejecting request`);
            lastQueueWarningTime = now;
        }
        metrics.queueOverflows++;
        return { acquired: false, release: () => {}, reason: 'queue_full' };
    }

    if (clientIp) recordIpRequest(clientIp);

    if (activeCalls < MAX_CONCURRENT) {
        activeCalls++;
        return {
            acquired: true,
            release: () => {
                activeCalls--;
                processQueue();
            }
        };
    }

    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            const idx = pendingQueue.findIndex(p => p.resolve === resolve);
            if (idx !== -1) pendingQueue.splice(idx, 1);
            resolve({ acquired: false, release: () => {}, reason: 'timeout' });
        }, timeout);

        pendingQueue.push({ resolve, timeoutId });
    });
}

function processQueue() {
    if (activeCalls >= MAX_CONCURRENT || pendingQueue.length === 0) return;
    const next = pendingQueue.shift();
    if (!next) return;
    clearTimeout(next.timeoutId);
    activeCalls++;
    next.resolve({
        acquired: true,
        release: () => {
            activeCalls--;
            processQueue();
        }
    });
}

export async function fetchWithFlaresolverr(url, options = {}) {
    if (!FLARESOLVERR_URL) {
        console.log('[FlareSolverr Manager] FlareSolverr not configured');
        return null;
    }

    const { timeout = 45000, headers = {}, proxy = null } = options;

    const slot = await acquireSlot(timeout);
    if (!slot.acquired) {
        console.warn(`[FlareSolverr Manager] Could not acquire slot: ${slot.reason}`);
        return null;
    }

    metrics.flaresolverrCalls++;
    const startTime = Date.now();

    try {
        const requestBody = {
            cmd: 'request.get',
            url,
            maxTimeout: timeout
        };

        if (headers['User-Agent']) {
            requestBody.userAgent = headers['User-Agent'];
        }

        if (proxy) {
            requestBody.proxy = proxy;
        }

        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: timeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        const solution = response?.data?.solution;
        if (!solution?.response) {
            console.log(`[FlareSolverr Manager] No response from FlareSolverr for ${url}`);
            recordFailure();
            metrics.flaresolverrFailures++;
            return null;
        }

        recordSuccess();
        metrics.flaresolverrSuccesses++;

        const duration = Date.now() - startTime;
        recordSlowResponse(duration);
        console.log(`[FlareSolverr Manager] Success for ${url} in ${duration}ms`);

        return {
            body: solution.response,
            cookies: solution.cookies || [],
            userAgent: solution.userAgent || headers['User-Agent'] || '',
            url: solution.url || url,
            status: solution.status
        };
    } catch (error) {
        console.error(`[FlareSolverr Manager] Error for ${url}: ${error.message}`);
        recordFailure();
        metrics.flaresolverrFailures++;
        return null;
    } finally {
        slot.release();
    }
}

export function getOverloadedResponse() {
    return {
        overloaded: true,
        message: 'Server is processing many requests. Please try again in a moment.',
        retryAfter: 30
    };
}

export function reset() {
    activeCalls = 0;
    pendingQueue.length = 0;
    circuitFailures = 0;
    circuitOpenedAt = null;
    domainCookieCache.clear();
    ipRequestCounts.clear();
    Object.keys(metrics).forEach(k => metrics[k] = 0);
}

export default {
    getStatus, isAvailable, isIpRateLimited, recordIpRequest, getIpRemainingRequests,
    getCachedCookies, cacheCookies, clearCachedCookies, markDirectAccessOk,
    shouldTryDirectFirst, acquireSlot, fetchWithFlaresolverr, getOverloadedResponse,
    reportFailure, reportTimeout, reset
};
