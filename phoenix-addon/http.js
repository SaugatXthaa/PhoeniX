/**
 * PhoeniX Addon - HTTP Client Utility
 * Centralized axios instance with sane defaults, retries, and timeouts.
 * Every source module imports this to keep behavior uniform.
 */

const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const logger = require('./logger');

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: 'https://www.google.com/',
  DNT: '1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Build an axios request config with sensible defaults.
 * @param {Object} opts - merge overrides
 */
function buildConfig(opts = {}) {
  const config = {
    timeout: 15000,
    headers: { ...BASE_HEADERS, ...(opts.headers || {}) },
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
    ...opts,
  };

  // Optional proxy via env
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    config.httpsAgent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl);
    config.proxy = false;
  }

  return config;
}

/**
 * GET request with automatic retry on transient failures.
 * @param {string} url
 * @param {Object} opts - axios overrides
 * @param {number} retries - number of retries (default 2)
 */
async function get(url, opts = {}, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, buildConfig(opts));
      return res;
    } catch (err) {
      lastError = err;
      const code = err.code || 'UNKNOWN';
      const status = err.response ? err.response.status : 'N/A';
      logger.warn(
        `HTTP GET failed [${code}/${status}] attempt ${attempt + 1}: ${url}`
      );
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * POST request with retry.
 */
async function post(url, data, opts = {}, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, data, buildConfig(opts));
      return res;
    } catch (err) {
      lastError = err;
      const code = err.code || 'UNKNOWN';
      logger.warn(
        `HTTP POST failed [${code}] attempt ${attempt + 1}: ${url}`
      );
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * HEAD request used to validate a resolved direct stream URL.
 * Returns true if the URL looks playable (2xx or 3xx with video content-type / length).
 */
async function probeStreamUrl(url, opts = {}) {
  try {
    const res = await axios.head(
      url,
      buildConfig({ ...opts, maxRedirects: 8 })
    );
    if (res.status >= 200 && res.status < 400) {
      const ct = (res.headers['content-type'] || '').toLowerCase();
      const cl = parseInt(res.headers['content-length'] || '0', 10);
      // accept any video/*, octet-stream, or unknown with reasonable size
      if (
        ct.startsWith('video/') ||
        ct.includes('octet-stream') ||
        ct.includes('mpegurl') ||
        cl > 1024 * 1024 ||
        ct === ''
      ) {
        return true;
      }
    }
    return false;
  } catch (_e) {
    return false;
  }
}

module.exports = { get, post, probeStreamUrl, BASE_HEADERS };
