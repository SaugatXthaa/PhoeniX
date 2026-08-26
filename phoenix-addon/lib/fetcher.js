/**
 * lib/fetcher.js — HTTP fetcher with Cloudflare bypass via FlareSolverr
 * Mirrors webstreamr's pattern: direct → proxy → FlareSolverr → cached UA+cookies
 */

const axios = require('axios');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { CookieJar, Cookie } = require('tough-cookie');

const DEFAULT_TIMEOUT = 12000;
const FLARESOLVERR_CACHE_TTL = 15 * 60 * 1000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 64 });

const cookieJar = new CookieJar();
const hostUserAgentMap = new Map();
const flareSolverrCache = new Map();

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getProxyForUrl(url) {
  // PROXY_CONFIG = "hostPattern1:http://user:pass@proxy:port,hostPattern2:socks5://..."
  const cfg = process.env.PROXY_CONFIG;
  if (cfg) {
    for (const rule of cfg.split(',')) {
      const [pat, proxy] = rule.split(/:(.+)/);
      if (!pat || !proxy) continue;
      if (pat === '*' || url.host.includes(pat) || url.hostname.includes(pat)) {
        if (proxy === 'false') return undefined;
        return proxy;
      }
    }
  }
  if (process.env.ALL_PROXY) return process.env.ALL_PROXY;
  return undefined;
}

function buildProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

async function fetch(url, opts = {}) {
  const targetUrl = typeof url === 'string' ? new URL(url) : url;
  const method = opts.method || 'GET';
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': hostUserAgentMap.get(targetUrl.host) || DEFAULT_UA,
    ...opts.headers
  };

  // Forwarded cookies
  const cookieStr = await cookieJar.getCookieString(targetUrl.href);
  if (cookieStr) headers.Cookie = cookieStr;

  const proxyUrl = getProxyForUrl(targetUrl);
  const proxyAgent = buildProxyAgent(proxyUrl);

  try {
    const response = await axios.request({
      method,
      url: targetUrl.href,
      headers,
      data: opts.body,
      timeout: opts.timeout || DEFAULT_TIMEOUT,
      maxRedirects: opts.maxRedirects ?? 5,
      validateStatus: () => true,
      transformResponse: [d => d],
      ...(proxyAgent ? { httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false } : { httpsAgent }),
      ...(opts.responseType ? { responseType: opts.responseType } : {})
    });

    // Cloudflare challenge?
    const cfMitigated = response.headers['cf-mitigated'] === 'challenge';
    const cfTurnstile = 'cf-turnstile' in (response.headers || {});
    const isCfBlocked = (response.status === 403 || response.status === 503) && (cfMitigated || cfTurnstile);

    if (response.status >= 200 && response.status <= 399 && !isCfBlocked) {
      return response;
    }

    // 429 rate-limit
    if (response.status === 429) {
      const retry = parseInt(response.headers['retry-after'] || '0', 10) * 1000;
      if (retry > 0 && retry < 8000) {
        await new Promise(r => setTimeout(r, retry));
        return fetch(url, opts); // single retry
      }
    }

    // Try FlareSolverr
    if (isCfBlocked) {
      const flareEndpoint = process.env.FLARESOLVERR_ENDPOINT;
      if (flareEndpoint) {
        const cached = flareSolverrCache.get(targetUrl.href);
        if (cached && Date.now() - cached.ts < FLARESOLVERR_CACHE_TTL) {
          return { status: 200, statusText: 'OK', data: cached.body, headers: cached.headers };
        }

        try {
          const fr = await axios.post(`${flareEndpoint}/v1`, {
            cmd: 'request.get',
            url: targetUrl.href,
            session: `phoenix_${targetUrl.host}`,
            session_ttl_minutes: 60,
            maxTimeout: 15000,
            disableMedia: true
          }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });

          if (fr.data?.status === 'ok' && fr.data.solution) {
            const sol = fr.data.solution;
            // Persist cookies + UA
            (sol.cookies || []).forEach(c => {
              if (!/^(__cf|cf_)/.test(c.name)) return;
              cookieJar.setCookieSync(new Cookie({
                domain: (c.domain || '').replace(/^\./, ''),
                expires: c.expiry ? new Date(c.expiry * 1000) : undefined,
                httpOnly: !!c.httpOnly,
                key: c.name, path: c.path || '/',
                sameSite: c.sameSite || 'Lax', secure: !!c.secure,
                value: c.value
              }), targetUrl.href);
            });
            if (sol.userAgent) hostUserAgentMap.set(targetUrl.host, sol.userAgent);

            const fakeResp = {
              status: sol.status || 200,
              statusText: 'OK',
              data: sol.response,
              headers: sol.headers || {}
            };
            flareSolverrCache.set(targetUrl.href, {
              ts: Date.now(), body: sol.response, headers: sol.headers || {}
            });
            return fakeResp;
          }
        } catch (e) { /* fall through */ }
      }
    }

    return response; // caller decides what to do with non-200
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      const e = new Error(`Timeout fetching ${targetUrl.href}`);
      e.isTimeout = true;
      throw e;
    }
    throw err;
  }
}

async function fetchText(url, opts) {
  return (await fetch(url, opts)).data;
}

async function fetchJson(url, opts) {
  const text = (await fetch(url, opts)).data;
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchHtml(url, opts) {
  return (await fetch(url, opts)).data;
}

module.exports = { fetch, fetchText, fetchJson, fetchHtml, cookieJar, hostUserAgentMap, DEFAULT_UA };
