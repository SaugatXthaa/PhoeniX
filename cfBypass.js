/**
 * PhoeniX - Cloudflare Bypass Module
 * cfBypass.js
 *
 * Uses node-tls-client to forge Chrome-compatible TLS/JA3 fingerprints
 * + HTTP/2 protocol handshake. This bypasses Cloudflare's Bot Fight Mode
 * which blocks standard axios/fetch requests.
 *
 * Features:
 *   - Chrome 120 JA3 fingerprint (clientIdentifier: 'chrome_120')
 *   - HTTP/2 forced (Cloudflare mandates this for "real" browsers)
 *   - Exact header ordering matching Chrome's natural sequence
 *   - Oxylabs residential proxy with sticky sessions (sessid)
 *   - Randomized delays between requests (1.5-3.8s)
 *
 * Env vars (already set on Render):
 *   PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS
 */

const { Session } = require('node-tls-client');
const logger = require('./logger');

// Chrome 120 header sequence (exact order matters for Cloudflare)
const CHROME_HEADERS = {
  'Host': '', // set per-request
  'Connection': 'keep-alive',
  'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,image/apng,*/*;q=0.8,' +
    'application/signed-exchange;v=b3;q=0.7',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
};

// TLS session variables declared in getSession() below

/**
 * Build the proxy URL for Oxylabs with sticky session support.
 * Appends a random sessid to the username to get a fresh residential IP.
 *
 * @param {boolean} sticky - if true, reuse the same session ID
 * @returns {string|null} - proxy URL or null if not configured
 */
function buildProxyUrl(sticky = false) {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;

  if (!host || !port) return null;

  // Sticky session: append sessid-<random> to username
  // This tells Oxylabs to bind a specific residential IP to this session
  let username = user || '';
  if (sticky) {
    if (!global._phoenixSessId) {
      global._phoenixSessId = Math.floor(Math.random() * 1000000);
    }
    username = `${user},sessid-${global._phoenixSessId}`;
  }

  if (user && pass) {
    return `http://${username}:${pass}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

/**
 * Randomized delay to mimic human browsing patterns.
 * Cloudflare blocks requests that arrive at exact intervals.
 */
async function humanDelay() {
  const delay = 1500 + Math.random() * 2300; // 1.5s - 3.8s
  await new Promise((r) => setTimeout(r, delay));
}

/**
 * Get or create a TLS client session.
 * Must call init() before using.
 */
let tlsSession = null;
let initPromise = null;

async function getSession() {
  if (tlsSession) return tlsSession;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const session = new Session({
      clientIdentifier: 'chrome_120',
      allowInsecure: false,
    });

    // node-tls-client requires async init
    await session.init();

    tlsSession = session;
    logger.info('[CFBypass] TLS session initialized (chrome_120, HTTP/2)');
    return session;
  })();

  return initPromise;
}

/**
 * Fetch a URL with Chrome TLS fingerprint + proxy.
 * Bypasses Cloudflare's Bot Fight Mode.
 *
 * @param {string} url - target URL
 * @param {Object} opts - { method, headers, body, sticky, delay }
 * @returns {Promise<{status, body, headers}|null>}
 */
async function fetch(url, opts = {}) {
  let session;
  try {
    session = await getSession();
  } catch (initErr) {
    logger.warn(`[CFBypass] TLS init failed: ${initErr.message}`);
    return null;
  }

  const proxyUrl = buildProxyUrl(opts.sticky !== false);

  // Build headers with correct Host + Chrome sequence
  const urlObj = new URL(url);
  const headers = {
    ...CHROME_HEADERS,
    Host: urlObj.hostname,
    ...(opts.headers || {}),
  };

  // Randomized delay before request (human-like)
  if (opts.delay !== false) {
    await humanDelay();
  }

  try {
    const requestOpts = {
      headers,
    };

    if (proxyUrl) {
      requestOpts.proxy = proxyUrl;
    }

    if (opts.method === 'POST' && opts.body) {
      requestOpts.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    const response = await session.get(url, requestOpts);

    logger.info(
      `[CFBypass] ${opts.method || 'GET'} ${url.substring(0, 60)} -> ${response.status} ` +
        `(len=${response.body ? response.body.length : 0})`
    );

    return {
      status: response.status,
      body: response.body,
      headers: response.headers,
    };
  } catch (err) {
    logger.warn(`[CFBypass] failed for ${url.substring(0, 60)}: ${err.message}`);
    return null;
  }
}

/**
 * GET request with Cloudflare bypass.
 */
async function get(url, opts = {}) {
  return fetch(url, { ...opts, method: 'GET' });
}

/**
 * POST request with Cloudflare bypass.
 */
async function post(url, body, opts = {}) {
  return fetch(url, { ...opts, method: 'POST', body });
}

/**
 * Check if Cloudflare bypass is available (proxy configured).
 */
function isAvailable() {
  return !!(process.env.PROXY_HOST && process.env.PROXY_PORT);
}

module.exports = {
  get,
  post,
  fetch,
  isAvailable,
  buildProxyUrl,
  humanDelay,
  CHROME_HEADERS,
};
