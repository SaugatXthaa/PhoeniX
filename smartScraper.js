/**
 * PhoeniX - Smart Scraper with ScrapingAnt Fallback
 * smartScraper.js
 *
 * ScrapingAnt free plan = 1 concurrent request.
 * ALL ScrapingAnt calls are serialized via a queue to prevent 409 errors.
 */

'use strict';

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('./logger');

const SCRAPINGANT_API_KEY = process.env.SCRAPINGANT_API_KEY || '';
const SCRAPINGANT_BASE = 'https://api.scrapingant.com/v2/general';

// ONLY directory111477 uses ScrapingAnt (most reliable, 5+ streams).
// Other CF sites try direct only (fast fail, no ScrapingAnt queue delay).
// This prevents 6 sources × 15s = 90s serialization that exceeds
// the 50s scrape timeout.
const CF_DOMAINS = [
  'a.111477.xyz',
  'p.111477.xyz',
];

const BLOCK_KEYWORDS = [
  'cloudflare', 'captcha', 'just a moment',
  'cf-browser-verification', 'cf-challenge',
  'attention required', 'access denied', 'error 1020',
];

// ============================================================
// SERIALIZED SCRAPINGANT QUEUE (free plan = 1 concurrent)
// ============================================================
let saQueue = Promise.resolve();

function serializeSA(url, opts) {
  const run = async () => {
    return await _fetchWithScrapingAnt(url, opts);
  };
  // Chain onto the queue - each call waits for the previous to finish
  const result = saQueue.then(run, run);
  // Don't let one failure break the chain
  saQueue = result.catch(() => null);
  return result;
}

// ============================================================
// DETECTION HELPERS
// ============================================================

function isBlocked(status, body) {
  if (status === 403 || status === 503 || status === 429) return true;
  if (body && body.length < 10000) {
    const lower = body.toLowerCase();
    for (const kw of BLOCK_KEYWORDS) {
      if (lower.includes(kw)) return true;
    }
  }
  return false;
}

function isCloudflareSite(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return CF_DOMAINS.some((d) => lower.includes(d));
}

function buildProxyUrl() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (!host || !port) return null;
  if (user && pass) return `http://${user}:${pass}@${host}:${port}`;
  return `http://${host}:${port}`;
}

function hasScrapingAnt() {
  return !!SCRAPINGANT_API_KEY;
}

// ============================================================
// DIRECT FETCH FUNCTIONS
// ============================================================

async function fetchWithProxy(url, opts = {}) {
  const proxyUrl = buildProxyUrl();
  const headers = opts.headers || {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const config = {
    timeout: opts.timeout || 12000,
    headers,
    maxRedirects: 5,
    validateStatus: (s) => s < 600,
    proxy: false,
  };

  if (proxyUrl) {
    try {
      config.httpsAgent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl, {
        keepAlive: true, keepAliveMsecs: 30000,
      });
    } catch (_) {}
  }

  try {
    const res = await axios.get(url, config);
    return { status: res.status, body: typeof res.data === 'string' ? res.data : String(res.data || '') };
  } catch (err) {
    if (err.code === 'ENOTFOUND') {
      try {
        const r = await axios.get(url, { timeout: opts.timeout || 12000, headers, maxRedirects: 5, validateStatus: s => s < 600, proxy: false });
        return { status: r.status, body: typeof r.data === 'string' ? r.data : String(r.data || '') };
      } catch (_) {}
    }
    return null;
  }
}

async function _fetchWithScrapingAnt(url, opts = {}) {
  if (!SCRAPINGANT_API_KEY) return null;

  const params = new URLSearchParams({ url, browser: 'true' });
  const apiUrl = `${SCRAPINGANT_BASE}?${params.toString()}`;

  try {
    const res = await axios.get(apiUrl, {
      timeout: opts.timeout || 45000,
      headers: { 'x-api-key': SCRAPINGANT_API_KEY, 'Accept': 'application/json' },
      validateStatus: (s) => s < 600,
      proxy: false,
      httpsAgent: undefined,
    });

    if (res.status !== 200) {
      const errBody = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
      logger.warn(`[SmartScraper] SA ${res.status}: ${errBody.substring(0, 150)}`);
      return null;
    }

    let body = '';
    if (typeof res.data === 'string') body = res.data;
    else if (res.data?.content) body = res.data.content;
    else if (res.data?.text) body = res.data.text;
    else if (res.data?.html) body = res.data.html;

    if (!body || body.length === 0) {
      logger.warn('[SmartScraper] SA returned 200 but empty body');
      return null;
    }

    return { status: 200, body };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0, 150) : err.message;
    logger.warn(`[SmartScraper] SA error: ${detail}`);
    return null;
  }
}

// Public wrapper - serializes calls to avoid 409 concurrency limit
async function fetchWithScrapingAnt(url, opts = {}) {
  return serializeSA(url, opts);
}

async function fetchDirect(url, opts = {}) {
  try {
    const res = await axios.get(url, {
      timeout: opts.timeout || 10000,
      headers: opts.headers || {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,*/*;q=0.8',
      },
      maxRedirects: 5,
      validateStatus: (s) => s < 600,
      proxy: false,
    });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : String(res.data || '') };
  } catch (_) {
    return null;
  }
}

// ============================================================
// SMART WRAPPER
// ============================================================

async function smartFetch(url, opts = {}) {
  if (!url) return null;

  try {
    const cfSite = isCloudflareSite(url);

    if (cfSite && hasScrapingAnt()) {
      // CF site: ScrapingAnt (serialized) → direct
      const saResult = await fetchWithScrapingAnt(url, opts);
      if (saResult && saResult.status === 200 && saResult.body && saResult.body.length > 0) {
        return { status: 200, body: saResult.body, source: 'scrapingant' };
      }
      const directResult = await fetchDirect(url, opts);
      if (directResult && !isBlocked(directResult.status, directResult.body)) {
        return { ...directResult, source: 'direct' };
      }
      return null;
    }

    // Normal site: proxy → direct
    const proxyResult = await fetchWithProxy(url, opts);
    if (proxyResult && !isBlocked(proxyResult.status, proxyResult.body)) {
      return { ...proxyResult, source: 'proxy' };
    }

    const directResult = await fetchDirect(url, opts);
    if (directResult && !isBlocked(directResult.status, directResult.body)) {
      return { ...directResult, source: 'direct' };
    }

    return null;
  } catch (err) {
    logger.error(`[SmartScraper] smartFetch crashed: ${err.message}`);
    return null;
  }
}

module.exports = {
  smartFetch,
  fetchWithProxy,
  fetchWithScrapingAnt,
  fetchDirect,
  isBlocked,
  isCloudflareSite,
  hasScrapingAnt,
  buildProxyUrl,
  CF_DOMAINS,
};
