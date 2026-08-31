'use strict';

/**
 * Stellar.rip extractor — standalone Node.js (CommonJS, ZERO npm dependencies).
 *
 * Turns a Stellar embed URL into direct, playable HLS/MP4 stream URLs.
 *   movie embed : https://stellar.rip/en/watch/embed/movie/{tmdbId}
 *   series embed: https://stellar.rip/en/watch/embed/tv/{tmdbId}-{season}-{episode}
 *
 * How it works (pure HTTP, no playwright / no flaresolverr / no proxy):
 *   1. GET the embed page               -> window.__REQUEST_TOKEN__ (JWT)
 *   2. POST /api/playback-init          -> either a stream token, or a PoW challenge
 *   3. Solve proof-of-work (SHA-256)    -> POST again with the nonce -> stream token
 *   4. POST /api/encrypt per server     -> signed GET for /api/stream-encrypted
 *      -> { data: { stream_url } }      -> direct HLS/MP4 URL (skips dead servers)
 *   5. Read each playlist once          -> real max resolution (up to 4K / 2160p)
 *                                          and audio language labels (sub/dub tracks)
 *
 * Direct-playability notes:
 *   - The stream CDN rejects non-browser User-Agents (error 1010) but ignores Referer
 *     and client IP, so every returned stream carries a browser UA via
 *     `requestHeaders` + Stremio-ready `behaviorHints.proxyHeaders`.
 *   - The API binds the request token to the client IP ("IP mismatch" rejections).
 *     ALL requests in a flow ride ONE shared keep-alive agent (same egress IP
 *     end-to-end), and the whole flow is retried with backoff when the API
 *     transiently rejects (per-IP throttling / egress IP rotation).
 *
 * Usage (library):
 *   const { extractStreams } = require('./stellar-extractor');
 *   const streams = await extractStreams('https://stellar.rip/en/watch/embed/movie/1081003');
 *
 * Usage (CLI):
 *   node stellar-extractor.js "https://stellar.rip/en/watch/embed/tv/83867-1-1"
 *
 * Environment:
 *   STELLAR_SERVERS   optional comma-separated server ids to probe (default: all 19)
 */

const { createHash } = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const BASE_URL = 'https://stellar.rip';

/** The CDN blocks non-browser UAs (error 1010); players must send this UA for direct playback. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Servers exposed by the Stellar web player (star-named, ID-based), in the player's
 * default order (Apple-only "Sirius" moved to the end).
 */
const DEFAULT_SERVERS = [
  { id: 's2',  name: 'Rigel',      capabilities: { fourKAvailability: 'confirmed', multiAudio: true } },
  { id: 's25', name: 'Vega',       capabilities: { fourKAvailability: 'confirmed' } },
  { id: 's26', name: 'Capella',    capabilities: { fourKAvailability: 'confirmed' } },
  { id: 's19', name: 'Betelgeuse', capabilities: { fourKAvailability: 'confirmed', multiAudio: true } },
  { id: 's13', name: 'Arcturus',   capabilities: { fourKAvailability: 'possible' } },
  { id: 's27', name: 'Canopus',    capabilities: { fourKAvailability: 'confirmed' } },
  { id: 's4',  name: 'Procyon' },
  { id: 's5',  name: 'Aldebaran' },
  { id: 's24', name: 'Spica' },
  { id: 's6',  name: 'Deneb' },
  { id: 's15', name: 'Altair' },
  { id: 's7',  name: 'Antares' },
  { id: 's8',  name: 'Regulus' },
  { id: 's16', name: 'Castor' },
  { id: 's1',  name: 'Polaris' },
  { id: 's12', name: 'Fomalhaut' },
  { id: 's10', name: 'Bellatrix' },
  { id: 's3',  name: 'Pollux',     capabilities: { multiAudio: true } },
  { id: 's0',  name: 'Sirius',     capabilities: { fourKAvailability: 'confirmed' } },
];

/** Retry backoff for transient "IP mismatch" / 403 rejections (whole flow re-run). */
const RETRY_DELAYS_MS = [1500, 6000];

/* -------------------------------------------------------------------------- */
/*  Shared keep-alive agent — THE critical piece                              */
/* -------------------------------------------------------------------------- */

/**
 * The API mints the embed-page token for the client IP and validates every
 * follow-up request against it. Egress IPs can rotate between TCP connections
 * on multi-IP hosts, so the ENTIRE flow (embed page, playback-init x2, encrypt,
 * stream-encrypted, playlist) MUST ride one shared keep-alive agent: same
 * connection pool, same egress IP, end to end.
 */
const sharedAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  keepAliveMsecs: 30000,
  rejectUnauthorized: false,
});

/** Closes all pooled sockets. Call once when your app is shutting down (CLI calls it internally). */
const destroy = () => sharedAgent.destroy();

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

class StellarIpMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StellarIpMismatchError';
  }
}

class StellarNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StellarNotFoundError';
  }
}

const isIpMismatch = (error) =>
  error instanceof StellarIpMismatchError ||
  String((error && error.message) || '').includes('IP mismatch');

/** Translates plain 403 responses (throttling / IP rejection) into retryable errors. */
const withIpMismatchDetection = async (call) => {
  try {
    return await call();
  } catch (error) {
    if (error && error.status === 403) {
      throw new StellarIpMismatchError(`Stellar API rejected with IP mismatch (403 for ${error.url || 'unknown URL'})`);
    }
    throw error;
  }
};

/* -------------------------------------------------------------------------- */
/*  Tiny HTTP layer (node:https, keep-alive, redirects, timeouts)             */
/* -------------------------------------------------------------------------- */

/**
 * Performs an HTTP(S) request. Resolves { status, headers, body }.
 * Follows up to `maxRedirects` redirects (POST -> GET on 301/302/303, kept on 307/308).
 */
function rawRequest(method, urlStr, options = {}) {
  const { headers = {}, body = null, timeout = 20000, maxRedirects = 5, referer = null } = options;

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const requestHeaders = { ...headers };
    if (referer) requestHeaders.Referer = referer;

    let payload = null;
    if (body !== null && body !== undefined) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      requestHeaders['Content-Length'] = payload.length;
    }

    const requestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: requestHeaders,
      agent: isHttps ? sharedAgent : undefined,
    };

    const request = mod.request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode || 0;
        const location = response.headers.location;

        if (location && status >= 300 && status < 400 && maxRedirects > 0) {
          let nextUrl;
          try {
            nextUrl = new URL(location, url).href;
          } catch {
            return reject(new Error(`Bad redirect location "${location}" for ${urlStr}`));
          }
          const keepMethod = status === 307 || status === 308;
          const nextMethod = keepMethod ? method : (method === 'HEAD' ? 'HEAD' : 'GET');
          const nextOptions = {
            ...options,
            maxRedirects: maxRedirects - 1,
            referer,
            body: keepMethod ? body : null,
            headers: keepMethod ? headers : { ...headers, 'Content-Length': undefined },
          };
          return rawRequest(nextMethod, nextUrl, nextOptions).then(resolve, reject);
        }

        const error = new Error(`HTTP ${status} for ${method} ${urlStr}`);
        error.status = status;
        error.url = urlStr;
        error.responseBody = text;
        resolve({ status, headers: response.headers, body: text, error });
      });
    });

    request.setTimeout(timeout, () => {
      request.destroy(new Error(`Request timed out after ${timeout}ms: ${method} ${urlStr}`));
    });
    request.on('error', reject);

    if (payload) request.write(payload);
    request.end();
  });
}

/** Browser-like base headers used across the whole flow. */
const baseHeaders = (referer) => ({
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  ...(referer ? { Referer: referer } : {}),
});

const jsonHeaders = (referer) => ({
  ...baseHeaders(referer),
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
});

/** GETs a URL and parses the body as JSON. Throws with .status=403 on 403 (IP mismatch signal). */
async function getJson(urlStr, referer) {
  const response = await rawRequest('GET', urlStr, { headers: jsonHeaders(referer) });
  if (response.status === 403) {
    const error = new Error(`HTTP 403 for ${urlStr}`);
    error.status = 403;
    error.url = urlStr;
    throw error;
  }
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status} for GET ${urlStr}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`Invalid JSON from GET ${urlStr}: ${response.body.slice(0, 200)}`);
  }
}

/** POSTs a JSON body and parses the response as JSON. Throws with .status=403 on 403. */
async function postJson(urlStr, data, referer) {
  const response = await rawRequest('POST', urlStr, {
    headers: jsonHeaders(referer),
    body: JSON.stringify(data),
  });
  if (response.status === 403) {
    const error = new Error(`HTTP 403 for ${urlStr}`);
    error.status = 403;
    error.url = urlStr;
    throw error;
  }
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status} for POST ${urlStr}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`Invalid JSON from POST ${urlStr}: ${response.body.slice(0, 200)}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Proof of work (mirrors stellar.rip/pow-worker.js)                         */
/* -------------------------------------------------------------------------- */

/**
 * Finds a nonce such that SHA-256(challenge + nonce) has `difficulty` leading zero bits.
 * Optimized with hash state reuse (base hash of the challenge is copied per attempt).
 */
function solveProofOfWork(challenge, difficulty) {
  const fullBytes = Math.floor(difficulty / 8);
  const remainingBits = difficulty % 8;
  const mask = (0xff << (8 - remainingBits)) & 0xff;

  const base = createHash('sha256').update(challenge);

  for (let nonce = 0; nonce <= 50000000; nonce++) {
    const hasher = base.copy();
    hasher.update(String(nonce));
    const digest = hasher.digest();

    let valid = true;
    for (let i = 0; i < fullBytes; i++) {
      if (digest[i] !== 0) {
        valid = false;
        break;
      }
    }
    if (valid && remainingBits > 0 && (digest[fullBytes] & mask) !== 0) {
      valid = false;
    }

    if (valid) {
      return String(nonce);
    }
  }

  throw new Error(`Proof of work challenge "${challenge}" could not be solved`);
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gets the servers to probe: built-in default list, or overridden via STELLAR_SERVERS env. */
function getServers() {
  const configured = (process.env.STELLAR_SERVERS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (!configured.length) {
    return DEFAULT_SERVERS.slice();
  }

  return configured.map((id) => {
    const known = DEFAULT_SERVERS.find((server) => server.id === id);
    return known || { id, name: id.toUpperCase() };
  });
}

/** Runs `worker` over `items` with bounded concurrency, preserving input order. */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Parses {mediaId, mediaType, tvSlug} out of an embed URL. */
function parseEmbedUrl(url) {
  const match = url.pathname.match(/^\/[a-z-]+\/watch\/embed\/(movie|tv)\/(\d+)(?:-(\d+)-(\d+))?$/);
  if (!match) {
    throw new StellarNotFoundError(`Unsupported Stellar embed URL "${url.href}"`);
  }

  const mediaType = match[1];
  const mediaId = parseInt(match[2], 10);
  const season = match[3] ? parseInt(match[3], 10) : undefined;
  const episode = match[4] ? parseInt(match[4], 10) : undefined;

  return {
    mediaId,
    mediaType,
    tvSlug: mediaType === 'tv' && season && episode ? `${season}-${episode}` : '',
  };
}

function qualityFromHeight(height) {
  if (!height) return null;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  return `${height}p`;
}

/**
 * Fetches a stream playlist once and derives the max video height plus the
 * audio (sub/dub) and subtitle language labels from it. Best-effort only.
 */
async function fetchPlaylistInfo(playlistUrl, referer) {
  const empty = { height: null, audioNames: [], subtitles: [] };
  try {
    const response = await rawRequest('GET', playlistUrl, {
      headers: baseHeaders(referer),
      timeout: 15000,
      maxRedirects: 5,
    });
    if (response.status >= 400) return empty;

    const playlist = response.body;

    const namesFrom = (type) => Array.from(
      playlist.matchAll(new RegExp(`#EXT-X-MEDIA:[^\\n]*TYPE="?${type}"?[^\\n]*`, 'g')),
    )
      .map((line) => {
        const match = line[0].match(/NAME="([^"]+)"/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
      .filter((name, index, names) => names.indexOf(name) === index);

    const audioNames = namesFrom('AUDIO');
    const subtitles = namesFrom('SUBTITLES');

    const heights = Array.from(playlist.matchAll(/RESOLUTION=\d+x(\d+)/g), (match) => parseInt(match[1], 10));

    return {
      height: heights.length ? Math.max(...heights) : null,
      audioNames,
      subtitles,
    };
  } catch {
    // Playlist info is best-effort only; the stream URL itself stays valid
    return empty;
  }
}

/** Builds a Stremio-ready stream object for one resolved server. */
function buildStream(server, streamUrl, isMp4, info, embedUrl) {
  const quality = qualityFromHeight(info.height);

  const capabilities = [];
  if (server.capabilities && server.capabilities.fourKAvailability === 'confirmed') capabilities.push('4K');
  else if (server.capabilities && server.capabilities.fourKAvailability === 'possible') capabilities.push('Possible 4K');
  if (server.capabilities && server.capabilities.multiAudio) capabilities.push('Multi-Audio');

  const titleBits = [server.name];
  if (capabilities.length) titleBits.push(`(${capabilities.join(', ')})`);
  if (quality) titleBits.push(quality);
  if (info.audioNames.length > 1) titleBits.push(`(Audio: ${info.audioNames.join(', ')})`);
  if (info.subtitles.length) titleBits.push(`(Subs: ${info.subtitles.join(', ')})`);
  const title = titleBits.filter(Boolean).join(' ');

  const stream = {
    server: server.id,
    serverName: server.name,
    name: 'Stellar',
    title,
    url: streamUrl.href,
    format: isMp4 ? 'mp4' : 'hls',
    ...(info.height ? { height: info.height } : {}),
    ...(quality ? { quality } : {}),
    ...(info.audioNames.length > 1 ? { audio: info.audioNames.join(', ') } : {}),
    ...(info.subtitles.length ? { subtitles: info.subtitles } : {}),
    requestHeaders: { 'User-Agent': BROWSER_UA },
    /* Stremio-ready hints: the CDN needs a browser UA, injected via proxyHeaders */
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: { 'User-Agent': BROWSER_UA } },
      ...(isMp4 ? {} : {}),
    },
    _embedUrl: embedUrl.href,
  };

  return stream;
}

/* -------------------------------------------------------------------------- */
/*  Core flow                                                                 */
/* -------------------------------------------------------------------------- */

/** playback-init (+ optional proof of work) -> stream token bound to the client IP. */
async function getStreamToken(media, requestToken, referer) {
  const payload = {
    mediaId: media.mediaId,
    mediaType: media.mediaType,
    tv_slug: media.tvSlug,
    requestToken,
  };

  let init = await withIpMismatchDetection(() => postJson(`${BASE_URL}/api/playback-init`, payload, referer));

  if (init.success && init.token) {
    return init.token;
  }

  if (!init.success && init.error === 'IP mismatch') {
    throw new StellarIpMismatchError('Stellar playback init rejected with IP mismatch');
  }

  if (!init.success || !init.requiresPow || !init.pow) {
    throw new Error(`Stellar playback init failed: ${init.error || 'unknown error'}`);
  }

  const nonce = solveProofOfWork(init.pow.challenge, init.pow.difficulty);
  const challengeId = init.pow.challengeId;

  init = await withIpMismatchDetection(() => postJson(`${BASE_URL}/api/playback-init`, { ...payload, pow: { challengeId, nonce } }, referer));

  if (!init.success || !init.token) {
    if (init.error === 'IP mismatch') {
      throw new StellarIpMismatchError('Stellar playback init rejected with IP mismatch after proof of work');
    }
    throw new Error(`Stellar playback init failed after proof of work: ${init.error || 'unknown error'}`);
  }

  return init.token;
}

/** Resolves one server: encrypt -> signed stream-encrypted GET -> direct stream URL. */
async function resolveServer(media, requestToken, streamToken, embedUrl, server, referer) {
  const encrypt = await withIpMismatchDetection(() => postJson(`${BASE_URL}/api/encrypt`, {
    data: {
      mediaId: media.mediaId,
      mediaType: media.mediaType,
      tv_slug: media.tvSlug,
      source: server.id,
    },
    endpoint: 'stream-encrypted',
    requestToken,
  }, referer));

  if (!encrypt || !encrypt.url) {
    return null;
  }

  const streamEncryptedUrl = new URL(encrypt.url, BASE_URL);
  streamEncryptedUrl.searchParams.set('requestToken', requestToken);
  streamEncryptedUrl.searchParams.set('token', streamToken);

  const streamResponse = await withIpMismatchDetection(() => getJson(streamEncryptedUrl.href, referer));

  if (!streamResponse.success || !streamResponse.data || !streamResponse.data.stream_url) {
    if (streamResponse.error === 'IP mismatch') {
      throw new StellarIpMismatchError(`Stellar server ${server.id} rejected with IP mismatch`);
    }
    return null;
  }

  const streamUrl = new URL(streamResponse.data.stream_url, BASE_URL);
  if (streamUrl.pathname.includes('playback-unavailable')) {
    return null;
  }

  const isMp4 = streamUrl.href.includes('.mp4');
  const info = isMp4
    ? { height: null, audioNames: [], subtitles: [] }
    : await fetchPlaylistInfo(streamUrl.href, referer);

  return buildStream(server, streamUrl, isMp4, info, embedUrl);
}

/** One full extraction pass (embed page -> token -> all servers in parallel). */
async function attemptExtract(embedUrl, options = {}) {
  const url = typeof embedUrl === 'string' ? new URL(embedUrl) : embedUrl;

  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'stellar.rip' && !host.endsWith('.stellar.rip')) {
    throw new StellarNotFoundError(`Not a Stellar embed URL: ${url.href}`);
  }

  const media = parseEmbedUrl(url);
  const referer = url.href;

  /* 1. Embed page -> request token */
  const embedResponse = await withIpMismatchDetection(() => rawRequest('GET', url.href, { headers: baseHeaders(referer) }));
  if (embedResponse.status === 403) {
    throw new StellarIpMismatchError(`Stellar embed page rejected with 403 for "${url.href}"`);
  }
  if (embedResponse.status >= 400) {
    throw new Error(`Failed to load Stellar embed page (HTTP ${embedResponse.status}): ${url.href}`);
  }

  const requestToken = (embedResponse.body.match(/window\.__REQUEST_TOKEN__\s*=\s*"([^"]+)"/) || [])[1];
  if (!requestToken) {
    throw new StellarNotFoundError(`No request token found on embed page "${url.href}"`);
  }

  /* 2. Stream token (playback-init + proof of work) */
  const streamToken = await getStreamToken(media, requestToken, referer);

  /* 3. Resolve all servers with bounded concurrency (8 at a time) */
  const servers = options.servers || getServers();
  const concurrency = Math.max(1, Math.min(options.concurrency || 8, servers.length));

  const serverErrors = [];
  const resolved = await mapPool(servers, concurrency, async (server) => {
    try {
      return await resolveServer(media, requestToken, streamToken, url, server, referer);
    } catch (error) {
      // A single failing server must not break the other servers
      serverErrors.push(error);
      return null;
    }
  });

  const streams = resolved.filter(Boolean);

  if (!streams.length) {
    if (serverErrors.some(isIpMismatch)) {
      throw new StellarIpMismatchError(`All Stellar servers rejected with IP mismatch for "${url.href}"`);
    }
    throw new StellarNotFoundError(`No playable Stellar server found for "${url.href}"`);
  }

  if (options.sort !== false) {
    /* Highest resolution first; stable within the same height (keeps player server order). */
    streams.sort((a, b) => (b.height || 0) - (a.height || 0));
  }

  return streams;
}

/**
 * Extracts direct playable streams from a Stellar embed URL.
 *
 * @param {string|URL} embedUrl  e.g. "https://stellar.rip/en/watch/embed/movie/1081003"
 * @param {object} [options]
 * @param {Array}  [options.servers]      server list override (default: all 19)
 * @param {number} [options.concurrency]  parallel server probes (default 8)
 * @param {boolean}[options.sort]         sort by resolution desc (default true)
 * @param {boolean}[options.verbose]      log retries to stderr (default false)
 * @returns {Promise<Array<object>>} Stremio-ready stream objects
 */
async function extractStreams(embedUrl, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptExtract(embedUrl, options);
    } catch (error) {
      const retryable = isIpMismatch(error) || (error && error.status === 403);
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (options.verbose) {
        console.error(`[stellar] attempt ${attempt + 1} failed (${error.message}); retrying in ${delay}ms`);
      }
      await sleep(delay);
    }
  }
}

module.exports = {
  extractStreams,
  solveProofOfWork,
  getServers,
  DEFAULT_SERVERS,
  BROWSER_UA,
  StellarIpMismatchError,
  StellarNotFoundError,
  destroy,
};

/* -------------------------------------------------------------------------- */
/*  CLI                                                                       */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const embedUrl = process.argv[2];
  if (!embedUrl) {
    console.error('Usage: node stellar-extractor.js "<stellar embed url>"');
    console.error('Example: node stellar-extractor.js "https://stellar.rip/en/watch/embed/movie/1081003"');
    process.exit(1);
  }

  extractStreams(embedUrl, { verbose: true })
    .then((streams) => {
      console.log(JSON.stringify(streams, null, 2));
      destroy();
    })
    .catch((error) => {
      console.error(`ERROR: [${error.name || 'Error'}] ${error.message}`);
      destroy();
      process.exit(1);
    });
}
