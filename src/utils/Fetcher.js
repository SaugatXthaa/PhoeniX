// src/utils/Fetcher.js

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { Mutex, Semaphore, withTimeout } from 'async-mutex';
import { CookieJar } from 'tough-cookie';
import { BlockedError, HttpError, NotFoundError, TimeoutError, TooManyRequestsError, TooManyTimeoutsError } from '../error/index.js';
import { BlockedReason } from '../types.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class Fetcher {
  constructor(logger) {
    this.logger = logger || console;
    this.DEFAULT_TIMEOUT = 10000;
    this.DEFAULT_QUEUE_LIMIT = 50;
    this.DEFAULT_QUEUE_TIMEOUT = 10000;
    this.DEFAULT_TIMEOUTS_COUNT_THROW = 30;
    this.cookieJar = new CookieJar();
    this.semaphores = new Map();
    this.timeoutsCount = new Map();
    this.cfProtectedDomains = new Map();
    this.CF_DOMAIN_CACHE_TTL = 60 * 60 * 1000;
  }

  setCookie(url, cookieString) {
    this.cookieJar.setCookieSync(cookieString, typeof url === 'string' ? url : url.href);
  }

  async fetch(ctx, url, options = {}) {
    return this.queuedFetch(ctx, url, options);
  }

  async text(ctx, url, options = {}) {
    return (await this.queuedFetch(ctx, url, options)).data;
  }

  async textPost(ctx, url, data, options = {}) {
    return (await this.queuedFetch(ctx, url, { ...options, method: 'POST', data })).data;
  }

  async head(ctx, url, options = {}) {
    return (await this.queuedFetch(ctx, url, { ...options, method: 'HEAD' })).headers;
  }

  async json(ctx, url, options = {}) {
    const text = await this.text(ctx, url, { headers: { Accept: 'application/json,text/plain,*/*' }, ...options });
    try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${url.href}`); }
  }

  async getFinalRedirectUrl(ctx, url, options = {}, maxCount = 10, count = 0) {
    if (count >= maxCount) return url;
    const response = await this.queuedFetch(ctx, url, { ...options, method: 'HEAD', maxRedirects: 0 });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      return this.getFinalRedirectUrl(ctx, new URL(response.headers.location, url.href), options, maxCount, count + 1);
    }
    return url;
  }

  async queuedFetch(ctx, url, options = {}) {
    const queueLimit = options.queueLimit ?? this.DEFAULT_QUEUE_LIMIT;
    const queueTimeout = options.queueTimeout ?? this.DEFAULT_QUEUE_TIMEOUT;
    let sem = this.semaphores.get(url.host);
    if (!sem) {
      sem = withTimeout(new Semaphore(queueLimit), queueTimeout);
      this.semaphores.set(url.host, sem);
    }
    const [, release] = await sem.acquire();
    try {
      return await this.fetchWithTimeout(ctx, url, options);
    } finally {
      release();
    }
  }

  handleErrorResponse(res, url, resolve, reject, options) {
    // Handle non-CF error responses
    if (res.statusCode === 404) {
      res.destroy();
      reject(new NotFoundError());
      return;
    }
    if (res.statusCode === 429) {
      const retryAfter = parseInt(res.headers['retry-after'] || '0') * 1000;
      res.destroy();
      reject(new TooManyRequestsError(url, retryAfter));
      return;
    }
    if (res.statusCode >= 400) {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        reject(new HttpError(url, res.statusCode, res.statusMessage, res.headers));
      });
      return;
    }
    // Success (shouldn't reach here normally)
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      resolve({
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
        data: Buffer.concat(chunks).toString('utf8'),
      });
    });
  }

  async fetchWithTimeout(ctx, url, options = {}) {
    const timeout = options.timeout ?? this.DEFAULT_TIMEOUT;
    const cfDetectedAt = this.cfProtectedDomains.get(url.hostname);
    if (cfDetectedAt) {
      if (Date.now() - cfDetectedAt < this.CF_DOMAIN_CACHE_TTL) {
        throw new BlockedError(url, BlockedReason.cloudflare_challenge, {});
      }
      this.cfProtectedDomains.delete(url.hostname);
    }

    const cookieString = this.cookieJar.getCookieStringSync(url.href);
    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en',
      'User-Agent': DEFAULT_USER_AGENT,
      ...(cookieString && { Cookie: cookieString }),
      ...options.headers,
    };

    return new Promise((resolve, reject) => {
      const protocol = url.protocol === 'https:' ? https : http;
      const reqOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        timeout,
        headers,
      };

      const req = protocol.request(reqOptions, (res) => {
        // Follow redirects
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && options.maxRedirects !== 0) {
          const redirectUrl = new URL(res.headers.location, url.href);
          res.destroy();
          this.fetchWithTimeout(ctx, redirectUrl, options).then(resolve).catch(reject);
          return;
        }

        // Cloudflare detection — try got-scraping fallback for 403
        if (res.headers['cf-mitigated'] === 'challenge' || res.statusCode === 403) {
          this.cfProtectedDomains.set(url.hostname, Date.now());

          // Try got-scraping fallback (bypasses some CF challenges)
          if (!options.method || options.method === 'GET') {
            // Import dynamically and handle async
            import('got-scraping').then(async ({ gotScraping }) => {
              const cookieString = this.cookieJar.getCookieStringSync(url.href);
              try {
                const resp = await gotScraping.get(url.href, {
                  headers: {
                    ...(cookieString && { Cookie: cookieString }),
                    ...(options.headers || {}),
                  },
                  timeout: { request: options.timeout ?? this.DEFAULT_TIMEOUT },
                  throwHttpErrors: false,
                });

                if (resp.statusCode >= 200 && resp.statusCode <= 399) {
                  const setCookies = resp.headers['set-cookie'];
                  if (setCookies) {
                    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
                    for (const c of cookies) {
                      try { this.cookieJar.setCookieSync(c, url.href); } catch {}
                    }
                  }
                  resolve({
                    status: resp.statusCode,
                    statusText: resp.statusMessage || '',
                    headers: resp.headers,
                    data: resp.body,
                  });
                  return;
                }
              } catch (e) {
                // got-scraping also failed
              }
              // Fall through to normal error handling below
              this.handleErrorResponse(res, url, resolve, reject, options);
            }).catch(() => {
              this.handleErrorResponse(res, url, resolve, reject, options);
            });
            return; // Don't continue processing — async handler above will resolve/reject
          }
        }

        // 404
        if (res.statusCode === 404) {
          res.destroy();
          reject(new NotFoundError());
          return;
        }

        // Rate limit
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] || '0') * 1000;
          res.destroy();
          reject(new TooManyRequestsError(url, retryAfter));
          return;
        }

        // Error status
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            reject(new HttpError(url, res.statusCode, res.statusMessage, res.headers));
          });
          return;
        }

        // Success — collect body
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            data: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNABORTED') {
          reject(new TimeoutError(url));
        } else {
          reject(err);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new TimeoutError(url));
      });

      if (options.data) {
        req.write(options.data);
      }
      req.end();
    });
  }
}
