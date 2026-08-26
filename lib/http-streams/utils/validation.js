// lib/http-streams/utils/validation.js
// Faithful port of sootio-stremio-addon/lib/http-streams/utils/validation.js
// Simplified: removed debridProxyManager dependency

import https from 'https';
import http from 'http';
import { URL } from 'url';

// Lazy proxy agent lookup (same as http.js)
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const socksAgentCache = new Map();
const httpsAgentCache = new Map();

function getProxyAgent() {
    const proxyUrl = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (!proxyUrl) return null;
    if (proxyUrl.startsWith('socks')) {
        if (!socksAgentCache.has(proxyUrl)) {
            socksAgentCache.set(proxyUrl, new SocksProxyAgent(proxyUrl));
        }
        return socksAgentCache.get(proxyUrl);
    }
    if (proxyUrl.startsWith('http')) {
        if (!httpsAgentCache.has(proxyUrl)) {
            const a = new HttpsProxyAgent(proxyUrl);
            a.options = a.options || {};
            a.options.rejectUnauthorized = false;
            httpsAgentCache.set(proxyUrl, a);
        }
        return httpsAgentCache.get(proxyUrl);
    }
    return null;
}

export function extractFilenameFromHeader(contentDisposition) {
    if (!contentDisposition) return null;

    const patterns = [
        /filename\*=UTF-8''(.+?)(?:;|$)/i,
        /filename\*=([^;]+)/i,
        /filename="(.+?)"/i,
        /filename=([^;]+)/i
    ];

    for (const pattern of patterns) {
        const match = contentDisposition.match(pattern);
        if (match && match[1]) {
            let filename = match[1].trim();
            try {
                filename = decodeURIComponent(filename);
            } catch (e) {}
            const cleanFilename = filename.replace(/\.(mkv|mp4|avi|webm)$/i, '');
            if (cleanFilename.length > 50 && /^[A-Za-z0-9_-]+$/.test(cleanFilename)) {
                return '';
            }
            return cleanFilename;
        }
    }
    return null;
}

export function validateUrl(url, options = {}) {
    const timeout = typeof options.timeout === 'number'
        ? options.timeout
        : (parseInt(process.env.VALIDATION_TIMEOUT) || 8000);
    const disableValidation = process.env.DISABLE_URL_VALIDATION === 'true';

    if (disableValidation) return Promise.resolve(true);

    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);
            const trustedHosts = [
                'pixeldrain.dev', 'pixeldrain.com', 'r2.dev', 'workers.dev',
                'hubcdn.fans', 'googleusercontent.com'
            ];
            const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));
            if (isTrustedHost) {
                resolve(true);
                return;
            }

            const protocol = urlObj.protocol === 'https:' ? https : http;
            const reqOptions = {
                method: 'HEAD',
                timeout: timeout,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            };

            const proxyAgent = getProxyAgent();
            if (proxyAgent) reqOptions.agent = proxyAgent;

            const req = protocol.request(url, reqOptions, (res) => {
                const isValid = res.statusCode >= 200 && res.statusCode < 400;
                res.destroy();
                resolve(isValid);
            });

            req.on('error', () => {
                req.destroy();
                resolve(false);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.setTimeout(timeout);
            req.end();
        } catch (error) {
            resolve(false);
        }
    });
}

export function validateSeekableUrl(url, options = {}) {
    const timeout = typeof options.timeout === 'number'
        ? options.timeout
        : (parseInt(process.env.VALIDATION_TIMEOUT) || 8000);
    const disableSeekValidation = process.env.DISABLE_SEEK_VALIDATION === 'true';
    const { requirePartialContent = false } = options;

    if (disableSeekValidation) {
        if (requirePartialContent) {
            return Promise.resolve({ isValid: false, filename: null, statusCode: null });
        }
        return validateUrl(url, { timeout }).then(isValid => ({ isValid, filename: null, statusCode: null }));
    }

    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);
            const trustedHosts = [
                'pixeldrain.dev', 'pixeldrain.com', 'r2.dev', 'workers.dev',
                'hubcdn.fans', 'googleusercontent.com'
            ];
            const isTrustedHost = trustedHosts.some(host => urlObj.hostname.includes(host));

            // Determine Referer for CDNs that require it
            const refererForHost = (() => {
                const h = urlObj.hostname.toLowerCase();
                if (h.includes('workers.dev') || h.includes('fileshubcdn') || h.includes('vmpx.online') || h.includes('vmwesa.online')) {
                    return 'https://gamerxyt.com/';
                }
                if (h.includes('hubcdn') || h.includes('hubcloud')) {
                    return 'https://hubcloud.ist/';
                }
                return null;
            })();

            if (isTrustedHost && !requirePartialContent) {
                const protocol = urlObj.protocol === 'https:' ? https : http;
                const reqHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
                if (refererForHost) {
                    reqHeaders['Referer'] = refererForHost;
                    reqHeaders['Range'] = 'bytes=0-0';
                }
                const reqOptions = {
                    method: 'HEAD',
                    timeout: timeout,
                    headers: reqHeaders
                };
                const proxyAgent = getProxyAgent();
                if (proxyAgent) reqOptions.agent = proxyAgent;

                const req = protocol.request(url, reqOptions, (res) => {
                    const filename = extractFilenameFromHeader(res.headers['content-disposition']);
                    let contentLength = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
                    const contentRange = res.headers['content-range'];
                    if (contentRange) {
                        const match = contentRange.match(/\/(\d+)/);
                        if (match && match[1] && !Number.isNaN(parseInt(match[1], 10))) {
                            contentLength = parseInt(match[1], 10);
                        }
                    }
                    res.destroy();
                    resolve({ isValid: true, filename, statusCode: res.statusCode, contentLength });
                });

                req.on('error', () => {
                    req.destroy();
                    resolve({ isValid: true, filename: null, statusCode: null, contentLength: null });
                });
                req.on('timeout', () => {
                    req.destroy();
                    resolve({ isValid: true, filename: null, statusCode: null, contentLength: null });
                });
                req.setTimeout(timeout);
                req.end();
                return;
            }

            const maxRedirects = typeof options.maxRedirects === 'number' ? options.maxRedirects : 3;
            const baseHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Range': 'bytes=0-0'
            };
            const proxyAgent = getProxyAgent();

            const requestWithRedirect = (currentUrl, depth = 0) => {
                const current = new URL(currentUrl);
                const protocol = current.protocol === 'https:' ? https : http;
                const reqOptions = {
                    method: 'HEAD',
                    timeout: timeout,
                    headers: baseHeaders
                };
                if (proxyAgent) reqOptions.agent = proxyAgent;

                const req = protocol.request(currentUrl, reqOptions, (res) => {
                    if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && depth < maxRedirects) {
                        const redirectUrl = new URL(res.headers.location, currentUrl).toString();
                        res.destroy();
                        requestWithRedirect(redirectUrl, depth + 1);
                        return;
                    }

                    const filename = extractFilenameFromHeader(res.headers['content-disposition']);
                    let contentLength = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
                    const contentRange = res.headers['content-range'];
                    if (contentRange) {
                        const match = contentRange.match(/\/(\d+)/);
                        if (match && match[1] && !Number.isNaN(parseInt(match[1], 10))) {
                            contentLength = parseInt(match[1], 10);
                        }
                    }

                    const isPixelDrain = url.includes('pixeldrain');
                    if (isPixelDrain && !requirePartialContent) {
                        res.destroy();
                        resolve({ isValid: true, filename, statusCode: res.statusCode, contentLength });
                        return;
                    }

                    const supportsRanges = res.statusCode === 206 ||
                                          (res.statusCode === 200 && res.headers['accept-ranges'] && res.headers['accept-ranges'] !== 'none');
                    const isValid = res.statusCode >= 200 && res.statusCode < 300;

                    if (urlObj.hostname.includes('googleusercontent.com')) {
                        if (res.statusCode === 206) {
                            res.destroy();
                            resolve({ isValid: true, filename, statusCode: res.statusCode, contentLength });
                            return;
                        } else if (!requirePartialContent && res.statusCode === 200 && res.headers['accept-ranges'] && res.headers['accept-ranges'] !== 'none') {
                            res.destroy();
                            resolve({ isValid: true, filename, statusCode: res.statusCode, contentLength });
                            return;
                        } else {
                            res.destroy();
                            resolve({ isValid: false, filename, statusCode: res.statusCode, contentLength });
                            return;
                        }
                    }

                    const isSeekable = isValid && supportsRanges;
                    const meetsPartialRequirement = !requirePartialContent || res.statusCode === 206;
                    const finalValidity = isSeekable && meetsPartialRequirement;

                    res.destroy();
                    resolve({ isValid: finalValidity, filename, statusCode: res.statusCode, contentLength });
                });

                req.on('error', () => {
                    req.destroy();
                    resolve({ isValid: false, filename: null, statusCode: null, contentLength: null });
                });
                req.on('timeout', () => {
                    req.destroy();
                    resolve({ isValid: false, filename: null, statusCode: null, contentLength: null });
                });
                req.setTimeout(timeout);
                req.end();
            };

            requestWithRedirect(url);
        } catch (error) {
            resolve({ isValid: false, filename: null, statusCode: null, contentLength: null });
        }
    });
}
