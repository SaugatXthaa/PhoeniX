// lib/http-streams/utils/http.js
// Faithful port of sootio-stremio-addon/lib/http-streams/utils/http.js
// Simplified: removed debridProxyManager dependency, use ALL_PROXY env var directly

import https from 'https';
import http from 'http';
import { URL } from 'url';
import * as cheerio from 'cheerio';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

const DEFAULT_MAX_BODY_SIZE = parseInt(process.env.HTTP_RESPONSE_MAX_BYTES || '2097152', 10); // 2MB

// Lazy-loaded proxy agents (cached by proxy URL)
const socksAgentCache = new Map();
const httpsAgentCache = new Map();

function getProxyAgent(serviceName = 'httpstreams') {
    const proxyUrl = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (!proxyUrl) return null;

    // Per-service override
    const serviceProxy = process.env[`${serviceName.toUpperCase().replace(/-/g, '_')}_PROXY`];
    const finalProxy = serviceProxy || proxyUrl;
    if (!finalProxy) return null;

    if (finalProxy.startsWith('socks')) {
        if (!socksAgentCache.has(finalProxy)) {
            socksAgentCache.set(finalProxy, new SocksProxyAgent(finalProxy));
        }
        return socksAgentCache.get(finalProxy);
    }
    if (finalProxy.startsWith('http')) {
        if (!httpsAgentCache.has(finalProxy)) {
            const httpsAgent = new HttpsProxyAgent(finalProxy);
            httpsAgent.options = httpsAgent.options || {};
            httpsAgent.options.rejectUnauthorized = false;
            httpsAgentCache.set(finalProxy, httpsAgent);
        }
        return httpsAgentCache.get(finalProxy);
    }
    return null;
}

/**
 * Makes an HTTP/HTTPS request with retry logic
 * @param {string} url - URL to request
 * @param {Object} options - Request options
 * @returns {Promise<{statusCode: number, headers: Object, body: string, document: Object|null, url: string}>}
 */
export function makeRequest(url, options = {}) {
    const DEFAULT_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 8000;
    const MAX_RETRIES = typeof options.maxRetries === 'number'
        ? options.maxRetries
        : (parseInt(process.env.REQUEST_MAX_RETRIES) || 1);
    const RETRY_DELAY = typeof options.retryDelay === 'number'
        ? options.retryDelay
        : (parseInt(process.env.REQUEST_RETRY_DELAY) || 800);
    const requestTimeout = typeof options.timeout === 'number' ? options.timeout : DEFAULT_TIMEOUT;
    const maxBodySize = typeof options.maxBodySize === 'number'
        ? options.maxBodySize
        : DEFAULT_MAX_BODY_SIZE;

    const requestOnce = () => new Promise((resolve, reject) => {
        let settled = false;
        let req = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (options.signal) {
                options.signal.removeEventListener('abort', onAbort);
            }
            fn(value);
        };

        const onAbort = () => {
            const abortError = new Error('Request aborted');
            if (req) req.destroy();
            finish(reject, abortError);
        };

        try {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const isHubDomain = (() => {
                try {
                    const hostname = urlObj.hostname.toLowerCase();
                    return hostname.includes('hubcloud') || hostname.includes('hubdrive') || hostname.includes('hubcdn');
                } catch {
                    return false;
                }
            })();
            const defaultUserAgent = isHubDomain
                ? (process.env.HUBCLOUD_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0')
                : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                timeout: requestTimeout,
                headers: {
                    'User-Agent': defaultUserAgent,
                    ...options.headers
                }
            };

            const body = options.body;
            if (body && !requestOptions.headers['Content-Length']) {
                const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
                requestOptions.headers['Content-Length'] = length;
            }

            const serviceName = options.serviceName || 'httpstreams';
            const shouldBypassProxy = (options.disableProxy === true && options.forceProxy !== true)
                || (options.forceProxy !== true && (() => {
                    try {
                        const hostname = new URL(url).hostname.toLowerCase();
                        return hostname.includes('hubcloud') || hostname.includes('hubdrive') || hostname.includes('hubcdn');
                    } catch {
                        return false;
                    }
                })());

            if (options.agent) {
                requestOptions.agent = options.agent;
            } else if (!shouldBypassProxy) {
                const proxyAgent = getProxyAgent(serviceName);
                if (proxyAgent) {
                    requestOptions.agent = proxyAgent;
                }
            }

            req = protocol.request(requestOptions, (res) => {
                if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) &&
                    res.headers.location && options.allowRedirects !== false) {
                    const redirectUrl = new URL(res.headers.location, url).toString();
                    console.log(`Following redirect from ${url} to ${redirectUrl}`);
                    res.destroy();
                    finish(resolve, makeRequest(redirectUrl, options));
                    return;
                }

                const chunks = [];
                let receivedBytes = 0;
                let abortedForSize = false;

                res.on('data', chunk => {
                    if (abortedForSize || settled) return;
                    receivedBytes += chunk.length;
                    if (receivedBytes > maxBodySize) {
                        abortedForSize = true;
                        const sizeError = new Error(`Response exceeded max body size (${maxBodySize} bytes) for ${url}`);
                        res.destroy();
                        req.destroy();
                        finish(reject, sizeError);
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (abortedForSize || settled) return;
                    try {
                        const buffer = Buffer.concat(chunks);
                        const data = buffer.toString('utf8');
                        chunks.length = 0;
                        finish(resolve, {
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: data,
                            document: options.parseHTML ? cheerio.load(data) : null,
                            url: res.headers.location || url
                        });
                    } catch (err) {
                        finish(reject, new Error(`Failed to process response: ${err.message}`));
                    }
                });
            });

            if (options.signal) {
                if (options.signal.aborted) {
                    onAbort();
                    req.destroy();
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            req.on('error', (err) => {
                req.destroy();
                finish(reject, err);
            });

            req.on('timeout', () => {
                req.destroy();
                finish(reject, new Error(`Request timeout after ${requestTimeout}ms for ${url}`));
            });

            if (body) {
                req.write(body);
            }
            req.end();
        } catch (err) {
            finish(reject, err);
        }
    });

    return (async () => {
        let lastError;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await requestOnce();
            } catch (err) {
                lastError = err;
                if (attempt < MAX_RETRIES) {
                    console.log(`Request attempt ${attempt + 1} failed for ${url}, retrying in ${RETRY_DELAY}ms... Error: ${err.message}`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
            }
        }
        throw lastError;
    })();
}

// Domains fetch (used by 4KHDHub, HDHub4u — phisher98/TVVVV domains.json)
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DOMAIN_CACHE_TTL_MS = parseInt(process.env.DOMAIN_CACHE_TTL_MS, 10) || 15 * 60 * 1000;
let cachedDomains = null;
let domainCacheTimestamp = null;

export function getDomains() {
    const now = Date.now();
    if (cachedDomains && domainCacheTimestamp && (now - domainCacheTimestamp < DOMAIN_CACHE_TTL_MS)) {
        return Promise.resolve(cachedDomains);
    }

    return makeRequest(DOMAINS_URL)
        .then(response => {
            cachedDomains = JSON.parse(response.body);
            domainCacheTimestamp = Date.now();
            return cachedDomains;
        })
        .catch(error => {
            console.error('Failed to fetch domains:', error.message);
            if (cachedDomains) return cachedDomains;
            return null;
        });
}
