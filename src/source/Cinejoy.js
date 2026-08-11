// src/source/Cinejoy.js
// cinejoy.to — movies and TV series with multi-quality HLS streams
//
// Reverse-engineered from the Next.js bundle (BToEzF61.js). Fully server-side
// playable — NO Playwright/browser needed. Uses the api.shegu.st backend with
// a custom encryption + scrypt PoW challenge.
//
// API flow (verified live):
//   1. GET https://api.shegu.st/servers → list of server names (Lisbon, Solara, etc.)
//   2. Build payload path:
//      Movie:  /{server}/movie?imdb={imdb}&title={title}&tmdb={tmdb}&year={year}
//      TV:     /{server}/series?imdb={imdb}&title={title}&tmdb={tmdb}&year={year}&season={s}&episode={e}
//   3. Generate rid (encrypted request ID):
//      - W = 16 random bytes (salt), d = 12 random bytes (GCM IV)
//      - HKDF-SHA256(BASE_KEY, salt=W, info="lumen-wire-v2|c2s") → gcmKey(32) + maskKey(32) + maskIV(16)
//      - AES-GCM encrypt payload → ciphertext + tag
//      - inner = [0x02] + d + ciphertext + tag
//      - AES-CTR mask inner → masked
//      - rid = base64url(W + masked)
//   4. GET /challenge?rid={rid} → {v,b,s,e,n,r,p,d,k,g}
//   5. Solve scrypt PoW:
//      - salt = SHA-256("pow2-salt|" + s + "|" + b)
//      - For i=0,1,...: hash = scrypt("pow2|"+b+"|"+s+"|"+i, salt, N, r, p, dkLen=32)
//      - If leadingZeroBits(hash) >= d: c = i
//   6. X-At = base64(JSON.stringify({...challenge, c}))
//   7. GET /{rid} with header X-At → encrypted blob
//   8. Decrypt blob:
//      - keyMaterial = first 16 bytes
//      - HKDF-SHA256(BASE_KEY, salt=keyMaterial, info="lumen-wire-v2|s2c") → same key split
//      - AES-CTR unmask → inner
//      - AES-GCM decrypt → JSON: {"stream":[{"type":"hls","playlist":"https://help.earthcleaner.cc/playlist/{id}.m3u8"}]}
//   9. GET playlist with Referer: https://cinejoy.to/
//      → master m3u8 with 4K/1080p/720p/360p variants + audio tracks
//
// Streams require Referer: https://cinejoy.to/ — routed through /proxy.
// Uses Cinejoy's embedded TMDB key (8476a7ab80ad76f0936744df0430e67c) to avoid
// dependency on TMDB_API_KEY env var — reduces latency by fetching TMDB details
// in parallel with the server list.

import crypto from 'crypto';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const CINEJOY_ORIGIN = 'https://cinejoy.to';
const SHEGU_API = 'https://api.shegu.st';
const TMDB_KEY = '8476a7ab80ad76f0936744df0430e67c'; // baked into Cinejoy frontend
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Static HKDF base key (pc XOR wc arrays from BToEzF61.js)
const BASE_KEY = Buffer.from('4e46ba8a98e390508fab1bd9207d15516bec11b8a0b21f8fc1e1e66c9e95abef', 'hex');
const MARKER = 2, W_LEN = 16, IV_LEN = 12, TAG_LEN = 16;

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

function apiHeaders() {
  return {
    ...hg.getHeaders({ httpVersion: '2' }),
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${CINEJOY_ORIGIN}/`,
    'Origin': CINEJOY_ORIGIN,
  };
}

// Derive gcmKey(32) + maskKey(32) + maskIV(16) via HKDF-SHA256
function deriveKeys(keyMaterial, purpose) {
  const info = Buffer.from(`lumen-wire-v2|${purpose}`, 'utf8');
  const d = Buffer.from(crypto.hkdfSync('sha256', BASE_KEY, keyMaterial, info, 80));
  return { gcmKey: d.slice(0, 32), maskKey: d.slice(32, 64), maskIV: d.slice(64, 80) };
}

// Generate the rid (encrypted request ID)
function generateRid(payload) {
  const W = crypto.randomBytes(W_LEN);
  const d = crypto.randomBytes(IV_LEN);
  const { gcmKey, maskKey, maskIV } = deriveKeys(W, 'c2s');
  const aad = Buffer.from('lumen-wire-v2|c2s', 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', gcmKey, d);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const inner = Buffer.concat([Buffer.from([MARKER]), d, enc, tag]);
  const ctr = crypto.createCipheriv('aes-256-ctr', maskKey, maskIV);
  const masked = Buffer.concat([ctr.update(inner), ctr.final()]);
  return Buffer.concat([W, masked]).toString('base64url');
}

// Decrypt the response blob
function decryptBlob(blobBase64) {
  const buf = Buffer.from(blobBase64, 'base64url');
  const keyMaterial = buf.slice(0, W_LEN);
  const rest = buf.slice(W_LEN);
  const { gcmKey, maskKey, maskIV } = deriveKeys(keyMaterial, 's2c');
  const aad = Buffer.from('lumen-wire-v2|s2c', 'utf8');
  const ctr = crypto.createDecipheriv('aes-256-ctr', maskKey, maskIV);
  const inner = Buffer.concat([ctr.update(rest), ctr.final()]);
  if (inner[0] !== MARKER) throw new Error(`Invalid marker: ${inner[0]}`);
  const iv = inner.slice(1, 1 + IV_LEN);
  const ct = inner.slice(1 + IV_LEN, -TAG_LEN);
  const tag = inner.slice(-TAG_LEN);
  const dec = crypto.createDecipheriv('aes-256-gcm', gcmKey, iv);
  dec.setAAD(aad);
  dec.setAuthTag(tag);
  const decrypted = Buffer.concat([dec.update(ct), dec.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// Solve the scrypt PoW challenge with a time limit
// On Render's free tier (0.1 CPU), scrypt is ~5-10x slower than local
// Uses async setImmediate to avoid blocking the event loop (lets other
// sources run in parallel while we solve the PoW)
async function solvePoW(challenge) {
  const { b, s, n, r, p, d } = challenge;
  const saltHash = crypto.createHash('sha256').update(`pow2-salt|${s}|${b}`).digest();
  const maxmem = 128 * r * (n + p) * 2;
  const startTime = Date.now();
  const TIME_LIMIT_MS = 12000; // 12s — Render free tier is slow
  for (let i = 0; i < 1000000; i++) {
    if (i % 10 === 0) {
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        throw new Error('PoW solver timed out');
      }
      // Yield to event loop every 10 iterations so other sources can run
      await new Promise(resolve => setImmediate(resolve));
    }
    const hash = crypto.scryptSync(`pow2|${b}|${s}|${i}`, saltHash, 32, { N: n, r, p, maxmem });
    let lz = 0;
    for (const byte of hash) {
      if (byte === 0) { lz += 8; continue; }
      lz += Math.clz32(byte) - 24;
      break;
    }
    if (lz >= d) return i;
  }
  throw new Error('PoW solver failed');
}

// Fetch TMDB details (title, year, imdb_id) using Cinejoy's embedded key
async function fetchTmdbDetails(tmdbId, mediaType) {
  try {
    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=external_ids`;
    const res = await gotScraping.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: { request: 8000 },
      throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return null;
    const d = JSON.parse(res.body);
    const date = d.release_date || d.first_air_date || '';
    return {
      title: d.title || d.name || '',
      year: date ? String(parseInt(date.slice(0, 4))) : '',
      imdbId: d.external_ids?.imdb_id || d.imdb_id || '',
    };
  } catch { return null; }
}

export class Cinejoy extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinejoy';
    this.label = 'Cinejoy';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = CINEJOY_ORIGIN;
    this.fetcher = fetcher;
    // Stream URLs are stable (no token/expiry) — 30min cache
    this.ttl = 30 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const mediaType = tmdbId.season ? 'series' : 'movie';

    // Step 1: Fetch TMDB details + server list in parallel (saves ~1-2s)
    const [tmdbInfo, serversData] = await Promise.all([
      fetchTmdbDetails(tmdbId.id, mediaType),
      (async () => {
        try {
          const fullUrl = new URL(`${SHEGU_API}/servers`);
          const res = await gotScraping.get(fullUrl.href, {
            headers: apiHeaders(),
            timeout: { request: 10000 },
            throwHttpErrors: false,
            http2: true,
          });
          if (res.statusCode !== 200) return null;
          return JSON.parse(res.body);
        } catch { return null; }
      })(),
    ]);

    const name = tmdbInfo?.title || `TMDB ${tmdbId.id}`;
    const year = tmdbInfo?.year || '';
    const imdbId = tmdbInfo?.imdbId || '';
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const serverName = serversData?.servers?.[0]?.name || 'Lisbon';

    // Step 2: Build payload path
    const params = new URLSearchParams();
    if (imdbId) params.set('imdb', imdbId);
    if (name) params.set('title', name);
    params.set('tmdb', String(tmdbId.id));
    if (year) params.set('year', year);
    if (tmdbId.season) {
      params.set('season', String(tmdbId.season));
      params.set('episode', String(tmdbId.episode));
    }

    const sorted = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const query = sorted.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    const payload = `/${serverName}/${mediaType}?${query}`;

    // Step 3: Generate rid
    const rid = generateRid(payload);

    // Step 4: Fetch challenge
    const challengeUrl = new URL(`${SHEGU_API}/challenge`);
    challengeUrl.searchParams.set('rid', rid);
    const chRes = await gotScraping.get(challengeUrl.href, {
      headers: apiHeaders(),
      timeout: { request: 15000 },
      throwHttpErrors: false,
      http2: true,
    });
    if (chRes.statusCode !== 200) return [];
    let challenge;
    try { challenge = JSON.parse(chRes.body); } catch { return []; }
    if (challenge.v !== 2) return [];

    // Step 5: Solve PoW (scrypt — CPU intensive, ~1-5s)
    let c;
    try { c = await solvePoW(challenge); } catch { return []; }

    // Step 6: Build X-At token
    const xAt = Buffer.from(JSON.stringify({ ...challenge, c })).toString('base64');

    // Step 7: Fetch encrypted blob
    const blobUrl = new URL(`${SHEGU_API}/${rid}`);
    const blobRes = await gotScraping.get(blobUrl.href, {
      headers: { ...apiHeaders(), 'X-At': xAt },
      timeout: { request: 15000 },
      throwHttpErrors: false,
      http2: true,
    });
    if (blobRes.statusCode !== 200) return [];

    // Step 8: Decrypt blob to get playlist URL
    let playlistUrl;
    try {
      const decrypted = decryptBlob(blobRes.body);
      playlistUrl = decrypted?.stream?.[0]?.playlist;
    } catch { return []; }
    if (!playlistUrl) return [];

    // Step 9: Fetch master playlist
    let masterText;
    try {
      const plRes = await gotScraping.get(playlistUrl, {
        headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': '*/*', 'Referer': `${CINEJOY_ORIGIN}/` },
        timeout: { request: 15000 },
        throwHttpErrors: false,
        http2: true,
      });
      if (plRes.statusCode !== 200) return [];
      masterText = plRes.body;
    } catch { return []; }

    // Parse the master m3u8 to extract variant streams
    const results = [];
    const seenUrls = new Set();
    const lines = masterText.split('\n').map(l => l.trim()).filter(Boolean);
    let inf = null;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
        // Audio track info — could parse language for metadata
        continue;
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = line.slice('#EXT-X-STREAM-INF:'.length);
        const resolution = a.match(/RESOLUTION=([^,]+)/)?.[1] || '';
        const bandwidth = parseInt(a.match(/BANDWIDTH=(\d+)/)?.[1] || '0');
        const codecs = a.match(/CODECS="([^"]+)"/)?.[1] || '';
        inf = { resolution, bandwidth, codecs };
      } else if (line.startsWith('http') && inf) {
        if (seenUrls.has(line)) { inf = null; continue; }
        seenUrls.add(line);

        const h = parseInt(inf.resolution.split('x')[1] || '0');
        let qualityLabel = 'HD';
        if (h >= 2160) qualityLabel = '4K';
        else if (h >= 1080) qualityLabel = '1080p';
        else if (h >= 720) qualityLabel = '720p';
        else if (h >= 480) qualityLabel = '480p';
        else if (h >= 360) qualityLabel = '360p';

        let parsed;
        try { parsed = new URL(line); } catch { inf = null; continue; }

        results.push({
          url: parsed,
          format: Format.hls,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.en],
            title: `${titleBase} (Cinejoy ${qualityLabel})`,
            sourceId: this.id,
            sourceLabel: this.label,
            serverName,
            codecs: inf.codecs,
            bandwidth: inf.bandwidth,
            ...(h > 0 && { height: h }),
          },
        });
        inf = null;
      }
    }

    // If no variants found, use the playlist URL directly
    if (results.length === 0 && playlistUrl) {
      try {
        const parsed = new URL(playlistUrl);
        results.push({
          url: parsed,
          format: Format.hls,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.en],
            title: `${titleBase} (Cinejoy HD)`,
            sourceId: this.id,
            sourceLabel: this.label,
            serverName,
          },
        });
      } catch { /* invalid URL */ }
    }

    return results;
  }
}
