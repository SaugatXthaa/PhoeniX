/**
 * PhoeniX - Auto-Rotating Public Proxy Pool
 * proxyPool.js
 *
 * Fetches free HTTP proxies from ProxyScrape, validates them, and
 * rotates through them on failure. Falls back to direct connection
 * if all proxies fail.
 *
 * Sources:
 *   - https://api.proxyscrape.com/v2/ (primary, 100+ working proxies)
 *   - https://www.proxy-list.download/api/v1 (fallback)
 *
 * The pool is refreshed every 5 minutes to remove dead proxies.
 * Each proxy is tested with a 3s timeout before being added to the pool.
 *
 * Usage:
 *   const { getProxy, getWithProxyRotation, getPoolStats } = require('./proxyPool');
 *
 *   // Simple: get a random working proxy URL
 *   const proxyUrl = await getProxy();
 *
 *   // Smart: fetch a URL with automatic proxy rotation on failure
 *   const data = await getWithProxyRotation('https://a.111477.xyz/movies/');
 *
 * Env vars:
 *   PHOENIX_USE_FREE_PROXIES=on  -> enable the free proxy pool
 *   PHOENIX_PROXY_TEST_URL       -> URL to test proxies against (default: https://httpbin.org/ip)
 *   PHOENIX_PROXY_REFRESH_MS     -> refresh interval (default: 300000 = 5 min)
 *   PHOENIX_MAX_PROXY_RETRIES    -> max proxies to try before fallback (default: 5)
 */

'use strict';

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('./logger');

const ENABLED = (process.env.PHOENIX_USE_FREE_PROXIES || 'off').toLowerCase() === 'on';
const TEST_URL = process.env.PHOENIX_PROXY_TEST_URL || 'https://httpbin.org/ip';
const REFRESH_MS = parseInt(process.env.PHOENIX_PROXY_REFRESH_MS || '300000', 10);
const MAX_RETRIES = parseInt(process.env.PHOENIX_MAX_PROXY_RETRIES || '5', 10);

// In-memory proxy pool
let proxyPool = [];
let lastFetch = 0;
let isFetching = false;

// Stats
const stats = {
  fetched: 0,
  validated: 0,
  succeeded: 0,
  failed: 0,
  fallbackDirect: 0,
};

/**
 * Fetch a list of free HTTP proxies from ProxyScrape.
 * Returns array of "ip:port" strings.
 */
async function fetchProxyList() {
  const sources = [
    // ProxyScrape v2 API - returns plain text list of ip:port
    {
      url: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all',
      parse: (text) => text.trim().split(/\r?\n/).filter((l) => l.includes(':')),
    },
    // Proxy-list.download fallback
    {
      url: 'https://www.proxy-list.download/api/v1/get?type=http&timeout=3',
      parse: (text) => text.trim().split(/\r?\n/).filter((l) => l.includes(':')),
    },
    // Clarketm proxy list (GitHub raw)
    {
      url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
      parse: (text) => text.trim().split(/\r?\n/).filter((l) => l.includes(':')),
    },
  ];

  for (const source of sources) {
    try {
      const res = await axios.get(source.url, {
        timeout: 10000,
        headers: { Accept: 'text/plain, */*' },
        validateStatus: (s) => s < 500,
      });

      if (res.status === 200) {
        const text = typeof res.data === 'string' ? res.data : String(res.data);
        const proxies = source.parse(text);
        if (proxies.length > 0) {
          logger.info(`[ProxyPool] Fetched ${proxies.length} proxies from ${source.url.substring(0, 50)}`);
          stats.fetched += proxies.length;
          return proxies;
        }
      }
    } catch (err) {
      logger.debug(`[ProxyPool] Fetch failed from ${source.url.substring(0, 50)}: ${err.message}`);
    }
  }

  return [];
}

/**
 * Validate a single proxy by making a test request.
 * @param {string} proxyStr - "ip:port"
 * @returns {Promise<boolean>}
 */
async function validateProxy(proxyStr) {
  const proxyUrl = `http://${proxyStr}`;
  try {
    const agent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl);
    const res = await axios.get(TEST_URL, {
      httpsAgent: agent,
      proxy: false,
      timeout: 3000,
      validateStatus: (s) => s < 400,
    });
    return res.status === 200;
  } catch (_) {
    return false;
  }
}

/**
 * Refresh the proxy pool: fetch new list + validate a sample.
 * Only validates 20 proxies at a time (to avoid blocking).
 */
async function refreshPool() {
  if (isFetching) return;
  isFetching = true;

  try {
    const rawList = await fetchProxyList();
    if (!rawList.length) {
      logger.warn('[ProxyPool] No proxies fetched from any source');
      isFetching = false;
      return;
    }

    // Shuffle the list so we don't always validate the same proxies
    const shuffled = rawList.sort(() => Math.random() - 0.5);

    // Validate up to 30 proxies in parallel (batch of 10)
    const toValidate = shuffled.slice(0, 30);
    const validated = [];

    for (let i = 0; i < toValidate.length; i += 10) {
      const batch = toValidate.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (proxy) => {
          const ok = await validateProxy(proxy);
          return ok ? proxy : null;
        })
      );
      validated.push(...results.filter(Boolean));
    }

    proxyPool = validated;
    lastFetch = Date.now();
    stats.validated += validated.length;

    logger.info(`[ProxyPool] Pool refreshed: ${proxyPool.length} working proxies`);
  } catch (err) {
    logger.warn(`[ProxyPool] Refresh failed: ${err.message}`);
  } finally {
    isFetching = false;
  }
}

/**
 * Get a random working proxy from the pool.
 * Refreshes the pool if it's stale or empty.
 * @returns {Promise<string|null>} - proxy URL like "http://ip:port" or null
 */
async function getProxy() {
  if (!ENABLED) return null;

  // Refresh if pool is empty or stale
  if (proxyPool.length === 0 || Date.now() - lastFetch > REFRESH_MS) {
    await refreshPool();
  }

  if (proxyPool.length === 0) return null;

  // Pick a random proxy
  const proxyStr = proxyPool[Math.floor(Math.random() * proxyPool.length)];
  return `http://${proxyStr}`;
}

/**
 * Make an HTTP GET request with automatic proxy rotation.
 * Tries up to MAX_RETRIES proxies before falling back to direct connection.
 *
 * @param {string} url - target URL
 * @param {Object} opts - axios options (headers, timeout, etc.)
 * @returns {Promise<Object>} - axios response
 */
async function getWithProxyRotation(url, opts = {}) {
  const headers = opts.headers || {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  };

  const timeout = opts.timeout || 10000;

  // If free proxies are enabled, try them first
  if (ENABLED) {
    // Ensure pool is populated
    if (proxyPool.length === 0 || Date.now() - lastFetch > REFRESH_MS) {
      await refreshPool();
    }

    // Try up to MAX_RETRIES proxies
    const tried = new Set();
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (proxyPool.length === 0) break;

      // Pick a random proxy we haven't tried yet
      let proxyStr = null;
      for (let i = 0; i < proxyPool.length; i++) {
        const candidate = proxyPool[Math.floor(Math.random() * proxyPool.length)];
        if (!tried.has(candidate)) {
          proxyStr = candidate;
          tried.add(candidate);
          break;
        }
      }
      if (!proxyStr) break;

      const proxyUrl = `http://${proxyStr}`;
      try {
        const agent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl);
        const res = await axios.get(url, {
          ...opts,
          httpsAgent: agent,
          proxy: false,
          timeout,
          headers,
          validateStatus: (s) => s < 500,
          maxRedirects: 5,
        });

        if (res.status === 200) {
          stats.succeeded++;
          logger.debug(`[ProxyPool] Success via ${proxyStr}`);
          return res;
        }
      } catch (err) {
        stats.failed++;
        logger.debug(`[ProxyPool] Failed via ${proxyStr}: ${err.message}`);
        // Remove dead proxy from pool
        const idx = proxyPool.indexOf(proxyStr);
        if (idx >= 0) proxyPool.splice(idx, 1);
      }
    }
  }

  // Fallback: direct connection (no proxy)
  stats.fallbackDirect++;
  logger.debug(`[ProxyPool] Falling back to direct connection for ${url.substring(0, 60)}`);
  return axios.get(url, {
    ...opts,
    timeout,
    headers,
    validateStatus: (s) => s < 500,
    maxRedirects: 5,
  });
}

/**
 * Check if the proxy pool is enabled and has working proxies.
 */
function isEnabled() {
  return ENABLED;
}

/**
 * Get pool statistics for the dashboard.
 */
function getPoolStats() {
  return {
    enabled: ENABLED,
    poolSize: proxyPool.length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    isFetching,
    stats: { ...stats },
    config: {
      testUrl: TEST_URL,
      refreshMs: REFRESH_MS,
      maxRetries: MAX_RETRIES,
    },
  };
}

module.exports = {
  getProxy,
  getWithProxyRotation,
  refreshPool,
  isEnabled,
  getPoolStats,
};
