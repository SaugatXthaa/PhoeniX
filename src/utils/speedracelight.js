// src/utils/speedracelight.js
// Crypto + API client for vidking.net's backend (api.speedracelight.com)
// Ported from vidking.net's VideoPlayer-D5eTfQPp.js bundle.
//
// Flow:
//   1. fetchSeed(tmdbId)  → calls /seed?mediaId={tmdbId} → { seed, ttlMs }
//   2. fetchProvider({ endpoint, ...meta }) → returns { sources: [{url, quality, ...}], subtitles, ... }
//   3. Response body is base64+XOR-encrypted; decrypt with the seed + parseInt(tmdbId)
//
// All requests must carry Origin: https://www.vidking.net and Referer: https://www.vidking.net/
// or the API returns 403.

import { HttpError, TooManyRequestsError } from '../error/index.js';

export const SPEEDRACELIGHT_API_BASE = 'https://api.speedracelight.com';

// === Constants from the bundle ===
const Hl = [1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580];
const _f = [1732584193,4023233417,2562383102,271733878];
const Js = 61, Sf = 8, ms = 2654435769;
const Ys = [109, 118, 109, 49]; // "mvm1" magic prefix

const bf = l => (l * (l + 1) & 1) === 0;
const If = l => (l * (l + 1) & 1) === 1;

function ci(l) {
  l >>>= 0;
  l ^= l >>> 16;
  l = Math.imul(l, 2246822507) >>> 0;
  l ^= l >>> 13;
  l = Math.imul(l, 3266489909) >>> 0;
  l ^= l >>> 16;
  return l >>> 0;
}

function ps(l, o) {
  l >>>= 0;
  o &= 31;
  if (o === 0) return l >>> 0;
  return (l << o | l >>> 32 - o) >>> 0;
}

function Af(l) {
  let o = _f[0] >>> 0;
  for (let e = 0; e < l.length; e++) {
    o = ps((o ^ Math.imul(l.charCodeAt(e), Hl[e & 15])) >>> 0, 5);
  }
  return ci(o);
}

function wf(l) {
  const o = new Array(256);
  for (let i = 0; i < 256; i++) o[i] = i;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    e = (e + o[i] + l.charCodeAt(i % l.length)) & 255;
    const r = o[i];
    o[i] = o[e];
    o[e] = r;
  }
  return o;
}

function vf(l) {
  let o = 2166136261;
  for (let e = 0; e < l.length; e++) {
    o = Math.imul(o ^ l.charCodeAt(e), 16777619) >>> 0;
  }
  return ci(o);
}

function Nf(l, o, e) {
  return ((l ^ o) >>> 0 | (l & o & e) >>> 0) >>> 0;
}

function Rf(l, o) {
  if (If(l.length)) return { S: wf(l), acc: Af(l) };
  const e = new Array(Js);
  let i = ci(vf(l) ^ ci(o >>> 0 ^ ms)) >>> 0;
  for (let r = 0; r < Sf; r++) {
    if (bf(r)) {
      const n = i % Js;
      i = ps(i + ms >>> 0, 7 + (r & 7));
      e[n] = (i ^ ci(i)) >>> 0;
      i = ci(i + n >>> 0);
    } else {
      e[r] = Hl[r & 15];
    }
  }
  return { S: e, acc: ci(i ^ 2779096485) >>> 0 };
}

function Cf(l, o) {
  const e = l.S;
  let i = l.acc;
  const r = i % Js;
  const n = 0 - +(r in e);
  const u = e[r] >>> 0;
  const d = Math.imul(ms, o + 1) >>> 0;
  let g = Nf(i, (u ^ d) >>> 0, n);
  g = (ps(g + i >>> 0, r & 31) ^ ps(i, Math.imul(r, 7) & 31)) >>> 0;
  i = ci(g + ms >>> 0);
  e[r] = i >>> 0;
  l.acc = i;
  return i >>> 0;
}

function xf(l, o, e) {
  const i = Rf(l, o);
  const r = new Uint8Array(e);
  let n = 0;
  for (let u = 0; u < e;) {
    const d = Cf(i, n++);
    r[u++] = d & 255;
    if (u < e) r[u++] = d >>> 8 & 255;
    if (u < e) r[u++] = d >>> 16 & 255;
    if (u < e) r[u++] = d >>> 24 & 255;
  }
  return r;
}

// Base64url → Uint8Array
function Df(l) {
  const o = l.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(l.length / 4) * 4, '=');
  const bin = Buffer.from(o, 'base64').toString('binary');
  const i = new Uint8Array(bin.length);
  for (let r = 0; r < bin.length; r++) i[r] = bin.charCodeAt(r);
  return i;
}

// Decrypt response body (base64+XOR) → JSON string
export function decryptPayload(payload, seed, tmdbIdInt) {
  const i = Df(payload);
  const r = xf(seed, tmdbIdInt, i.length);
  for (let n = 0; n < i.length; n++) i[n] ^= r[n];
  for (let n = 0; n < Ys.length; n++) {
    if (i[n] !== Ys[n]) throw new Error('decrypt failed: bad seed or tampered payload');
  }
  return Buffer.from(i.subarray(Ys.length)).toString('utf8');
}

// === Provider registry (same as bundle's Vr) ===
// NOTE: Cypher (downloader2) and Breach (m4uhd) removed — their CDN URLs
// (ironwallnet.net) return 403 from server environments. These are token/
// IP-bound URLs that only play in a browser. Yoru provides the same content
// as direct MP4s (2160p/1080p/720p/480p) and works perfectly in Stremio.
export const PROVIDERS = [
  { name: 'Yoru',   endpoint: 'cdn/sources-with-title',         countryCodes: ['multi'] },
  { name: 'Neon',   endpoint: 'vsrc/sources-with-title',        countryCodes: ['multi'] },
  { name: 'Vyse',   endpoint: 'hdmovie/sources-with-title',     countryCodes: ['multi'], qualityFilter: 'English' },
  { name: 'Killjoy',endpoint: 'meine/sources-with-title',       countryCodes: ['de'],    params: { language: 'german' } },
  { name: 'Fade',   endpoint: 'hdmovie/sources-with-title',     countryCodes: ['hi'],    qualityFilter: 'Hindi' },
  { name: 'Omen',   endpoint: 'lamovie/sources-with-title',     countryCodes: ['multi'] },
  { name: 'Raze',   endpoint: 'superflix/sources-with-title',   countryCodes: ['multi'] },
];

// === API client ===
// Small in-process cache for seeds (TTL 25s — slightly less than the 30s server TTL)
const seedCache = new Map();
const SEED_CACHE_TTL = 25_000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchSeed(fetcher, ctx, tmdbId) {
  const key = String(tmdbId);
  const cached = seedCache.get(key);
  if (cached && Date.now() - cached.ts < SEED_CACHE_TTL) return cached.seed;

  const url = new URL(`/seed?mediaId=${encodeURIComponent(key)}`, SPEEDRACELIGHT_API_BASE);
  const headers = {
    'Origin': 'https://www.vidking.net',
    'Referer': 'https://www.vidking.net/',
  };

  // Retry on 429 with the server-provided Retry-After (or 2s default)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const json = await fetcher.json(ctx, url, { headers, timeout: 10000 });
      if (!json || !json.seed) throw new Error('seed response missing seed field');
      seedCache.set(key, { seed: json.seed, ts: Date.now() });
      return json.seed;
    } catch (e) {
      if (e instanceof TooManyRequestsError && attempt < 2) {
        const wait = e.retryAfter > 0 ? Math.min(e.retryAfter, 10000) : 2000;
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

// Drop the cached seed (after a 401, the bundle calls Lf() to invalidate)
export function invalidateSeed(tmdbId) {
  seedCache.delete(String(tmdbId));
}

// Fetch one provider's sources. Returns the parsed JSON object
// ({ sources: [{url, quality, ...}], subtitles: [...] }) or null on failure.
//
// Throws a tagged error `{ status: 401 }` (HttpError with status=401) when the
// seed is rejected — the caller should invalidate the seed and retry once.
export async function fetchProvider(fetcher, ctx, { provider, meta, type, tmdbId, seasonId, episodeId }) {
  const seed = await fetchSeed(fetcher, ctx, tmdbId);

  const u = new URL(`/${provider.endpoint}`, SPEEDRACELIGHT_API_BASE);
  u.searchParams.set('title', meta.title);
  u.searchParams.set('mediaType', type);
  u.searchParams.set('year', String(meta.year ?? ''));
  u.searchParams.set('episodeId', String(episodeId || 1));
  u.searchParams.set('seasonId', String(seasonId || 1));
  u.searchParams.set('tmdbId', String(tmdbId));
  u.searchParams.set('imdbId', meta.imdbId || '');
  u.searchParams.set('enc', '2');
  u.searchParams.set('seed', seed);
  u.searchParams.set('_t', String(Date.now()));
  if (provider.params) {
    for (const [k, v] of Object.entries(provider.params)) u.searchParams.append(k, v);
  }

  let body;
  try {
    body = await fetcher.text(ctx, u, {
      headers: {
        'Origin': 'https://www.vidking.net',
        'Referer': 'https://www.vidking.net/',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
      timeout: 15000,
    });
  } catch (e) {
    // Propagate 401 so caller can invalidate seed + retry
    if (e instanceof HttpError && e.status === 401) throw e;
    // Other HTTP errors (429, 500, etc.) — give up
    return null;
  }

  let decrypted;
  try {
    decrypted = decryptPayload(body, seed, parseInt(tmdbId));
  } catch {
    // Decryption failed — seed is stale. Throw a synthetic 401 so caller retries.
    const err = new Error('decrypt failed: bad seed or tampered payload');
    err.status = 401;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(decrypted);
  } catch {
    return null;
  }

  if (!json || !Array.isArray(json.sources)) return null;
  return json;
}

// Fetch all providers in parallel. Returns a map of providerName → sources array.
// On 401 (seed rejected), invalidates the seed and retries once.
export async function fetchAllProviders(fetcher, ctx, { meta, type, tmdbId, seasonId, episodeId }) {
  const tryProvider = async (provider) => {
    try {
      const json = await fetchProvider(fetcher, ctx, { provider, meta, type, tmdbId, seasonId, episodeId });
      return { provider, json };
    } catch (e) {
      // 401 — seed rejected. Invalidate and retry once.
      if ((e instanceof HttpError && e.status === 401) || e?.status === 401) {
        invalidateSeed(tmdbId);
        try {
          const json = await fetchProvider(fetcher, ctx, { provider, meta, type, tmdbId, seasonId, episodeId });
          return { provider, json };
        } catch {
          return { provider, json: null };
        }
      }
      return { provider, json: null };
    }
  };

  return Promise.all(PROVIDERS.map(tryProvider));
}
