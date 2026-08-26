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
  // Extract internal options before spreading to axios
  const { _targetUrl, _directFallback, ...axiosOpts } = opts;

  const config = {
    timeout: 15000,
    headers: { ...BASE_HEADERS, ...(axiosOpts.headers || {}) },
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
    ...axiosOpts,
  };

  // Optional proxy - only used for Cloudflare-protected sites.
  // Non-protected sites (Acer API, OMDB, Cinemeta) connect directly
  // to avoid proxy latency + rate limits.
  const proxyUrl = resolveProxyUrl();
  if (proxyUrl && shouldUseProxy(_targetUrl || '')) {
    try {
      config.httpsAgent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl, {
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 10,
      });
      config.proxy = false;
    } catch (err) {
      logger.warn(`Proxy agent creation failed: ${err.message}`);
    }
  }

  return config;
}

/**
 * Determine if a URL should be routed through the proxy.
 * Only Cloudflare-protected sites need the proxy. Other sites
 * (Acer API, OMDB, Cinemeta, TMDB) connect directly to avoid
 * proxy latency + data usage.
 */
function shouldUseProxy(url) {
  if (!url) return false;
  const PROXY_DOMAINS = [
    'a.111477.xyz',
    'p.111477.xyz',
    '4khdhub.one',
    '4khdhub.store',
    'pahe.ink',
    'uhdmovies.casa',
    'uhdmovies.autos',
    'nima4k.org',
    'mkvbase.site',
    'ddlbase.com',
    'mkvdrama.net',
    'top.xdmovies.wtf',
    'hdhub4u.cl',
    'fluxtv.cc',
    'fluxtv.co.uk',
    'fluxtv.qzz.io',
    'tenies.site',
    'showbox.media',
    'zxcstream.xyz',
    'zxcstream.icu',
    'mappletv.uk',
    'vidsrc.xyz',
    'zstream.mov',
    'aether.cx',
    'ernax.pro',
    'soap2night.cc',
    'lookmovie2.to',
    'streamex.sh',
    'anitaku.io',
    'anitaku.com.ro',
    'miruro.to',
    'aniworld.to',
  ];
  const lower = url.toLowerCase();
  return PROXY_DOMAINS.some((d) => lower.includes(d));
}

/**
 * Resolve proxy URL from environment variables.
 * Supports rotation if PROXY_URL contains comma-separated URLs.
 * @returns {string|null}
 */
function resolveProxyUrl() {
  // Format 1: HTTPS_PROXY / HTTP_PROXY (standard)
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    return process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  }

  // Format 2: PROXY_URL (supports comma-separated rotation)
  if (process.env.PROXY_URL) {
    const urls = process.env.PROXY_URL.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length === 1) return urls[0];
    if (urls.length > 1) {
      // Rotate: pick a random proxy from the pool
      return urls[Math.floor(Math.random() * urls.length)];
    }
  }

  // Format 3: PROXY_HOST + PROXY_PORT + optional PROXY_USER + PROXY_PASS
  if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    const auth =
      process.env.PROXY_USER && process.env.PROXY_PASS
        ? `${process.env.PROXY_USER}:${process.env.PROXY_PASS}@`
        : '';
    return `http://${auth}${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
  }

  return null;
}

/**
 * Check if a proxy is configured.
 */
function isProxyConfigured() {
  return !!resolveProxyUrl();
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
      const res = await axios.get(url, buildConfig({ ...opts, _targetUrl: url }));
      return res;
    } catch (err) {
      lastError = err;
      const code = err.code || 'UNKNOWN';
      const status = err.response ? err.response.status : 'N/A';

      // If the proxy itself can't be resolved (ENOTFOUND on proxy host),
      // retry WITHOUT the proxy on the next attempt.
      // This prevents a broken proxy from killing ALL requests.
      if (code === 'ENOTFOUND' && !opts._directFallback) {
        logger.warn(
          `HTTP GET proxy DNS failed [${code}] - retrying direct: ${url.substring(0, 60)}`
        );
        try {
          const directRes = await axios.get(url, {
            timeout: opts.timeout || 15000,
            headers: opts.headers || BASE_HEADERS,
            maxRedirects: 5,
            validateStatus: (s) => s < 500,
            proxy: false,
          });
          return directRes;
        } catch (directErr) {
          lastError = directErr;
          continue;
        }
      }

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
      const res = await axios.post(url, data, buildConfig({ ...opts, _targetUrl: url }));
      return res;
    } catch (err) {
      lastError = err;
      const code = err.code || 'UNKNOWN';

      // If the proxy itself can't be resolved, retry without proxy
      if (code === 'ENOTFOUND' && !opts._directFallback) {
        logger.warn(
          `HTTP POST proxy DNS failed [${code}] - retrying direct: ${url.substring(0, 60)}`
        );
        try {
          const directRes = await axios.post(url, data, {
            timeout: opts.timeout || 15000,
            headers: opts.headers || BASE_HEADERS,
            maxRedirects: 5,
            validateStatus: (s) => s < 500,
            proxy: false,
          });
          return directRes;
        } catch (directErr) {
          lastError = directErr;
          continue;
        }
      }

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

module.exports = { get, post, probeStreamUrl, BASE_HEADERS, isProxyConfigured, resolveProxyUrl };
