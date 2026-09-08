// reanime.to — Anime Stream Extractor (Direct Playable HLS via FlixCloud)
// ============================================================================
// Resolves DIRECT PLAYABLE HLS streams from reanime.to via the FlixCloud CDN.
//
// CHAIN
//   TMDB ID  →  reanime.to /api/v1/search?q=<title>     →  anime_id, anilist_id
//            →  reanime.to /api/flix/<anilist_id>/<ep>  →  FlixCloud server list
//            →  flixcloud.cc/e/<accessId>?v=<v>         →  encrypted SvelteKit payload
//            →  flixcloud.cc/api/m3u8/<tokenValue>      →  vid_b64 + key_b64
//            →  fetch8.flixcloud.cc/_v7/<vid>/master.m3u8?token=<JWT>
//                                                         (XOR-encrypted m3u8)
//            →  vault-95.atomic4cdn.top/_v7/<vid>/seg-N-f1-v1-a0.{webp,png}
//                                                         (image-disguised MPEG-TS)
//
// DECRYPTION
//   1. Master m3u8 URL: derive via WASM + PBKDF2 + AES-256-CBC (per-request seed)
//   2. m3u8 content:    base64-decode, XOR with 32-byte __pk (from WASM._c())
//   3. Segments:        strip 12-byte (webp) or 8-byte (png) fake header,
//                        XOR with hardcoded 16-byte key:
//                        [157,42,241,71,179,142,92,112,166,25,228,59,216,98,15,197]
//                        (hex: 9d2af147b38e5c70a619e43bd8620fc5)
//
// USAGE
//   node reanime_all_in_one.js <tmdbId> <movie|tv> [season] [episode]
//   node reanime_all_in_one.js search "haikyuu"
//   node reanime_all_in_one.js proxy [port]                    # default 7654
//
// Examples:
//   node reanime_all_in_one.js 71014 tv 1 1                     # Sagrada Reset S01E01
//   node reanime_all_in_one.js 60863 tv 1 1                     # HAIKYU!! S01E01
//   node reanime_all_in_one.js proxy                            # Start decryption proxy

'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROVIDER_NAME = 'ReAnime';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const REANIME_API = 'https://reanime.to';
const FLIXCLOUD = 'https://flixcloud.cc';

// Cloudflare fingerprints Node's TLS handshake (JA3) and rejects it with 403.
// curl's TLS handshake is browser-like and passes CF. We use the full Chrome
// UA string for reanime.to (which gates on the UA-Referer pair, not JA3).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// FlixCloud's CF flags the full Chrome UA as bot. The simple UA below passes.
const UA_SIMPLE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 16-byte XOR key used to decrypt segment payloads (extracted from FlixCloud's
// hls.js fork at /artplayer-new/hls.js?v=103, XhrLoader/FetchLoader handlers).
const SEGMENT_XOR_KEY = Buffer.from([157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── HTTP: curl-based (for reanime.to — CF JA3 protection) ───────────────────
function fetchBufCurl(url, { headers = {}, timeout = 30000 } = {}) {
  const finalHeaders = { 'User-Agent': UA, 'Accept': '*/*', ...headers };
  const args = ['-sL', '--max-time', String(Math.floor(timeout / 1000))];
  for (const [k, v] of Object.entries(finalHeaders)) args.push('-H', `${k}: ${v}`);
  args.push('-o', '-', '-w', '\n__HTTP_STATUS__%{http_code}', url);
  try {
    const out = execFileSync('curl', args, { maxBuffer: 50 * 1024 * 1024, timeout: timeout + 5000, encoding: 'buffer' });
    // Parse the trailing status marker that curl appended via -w
    const str = out.toString('utf8');
    const statusMatch = str.match(/__HTTP_STATUS__(\d+)\s*$/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 200;
    const body = statusMatch ? out.slice(0, out.length - statusMatch[0].length - 1) : out;
    return { status, headers: {}, body };
  } catch (e) {
    throw new Error(`curl failed for ${url}: ${(e.message || '').slice(0, 100)}`);
  }
}

// ─── HTTP: Node https (for flixcloud.cc, TMDB, fetch8, vault-95 — no CF JA3) ──
function fetchBufNode(url, { headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA_SIMPLE, 'Accept': '*/*', ...headers },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// ─── Fetch helpers with retry ────────────────────────────────────────────────
async function fetchJson(url, opts = {}, useCurl = true) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = useCurl
        ? await fetchBufCurl(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } })
        : await fetchBufNode(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}`);
      return JSON.parse(r.body.toString('utf8'));
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function fetchText(url, opts = {}, useCurl = true) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = useCurl ? await fetchBufCurl(url, opts) : await fetchBufNode(url, opts);
      if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}`);
      return r.body.toString('utf8');
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ─── TMDB info ────────────────────────────────────────────────────────────────
async function getTMDBInfo(tmdbId, type) {
  const isTV = type === 'tv' || type === 'series';
  const url = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  try {
    // TMDB has no CF protection — use Node's https directly (faster than spawning curl).
    const j = await fetchJson(url, {}, false);
    return {
      title: (isTV ? j.name : j.title) || 'Unknown',
      year: ((isTV ? j.first_air_date : j.release_date) || '').slice(0, 4),
      tmdbId: String(tmdbId),
      type,
    };
  } catch (e) {
    console.log(`[ReAnime] TMDB fetch failed: ${e.message}`);
    return null;
  }
}

// ─── reanime.to search (returns anilist_id + anime_id slug) ──────────────────
async function searchReanime(query) {
  try {
    const j = await fetchJson(`${REANIME_API}/api/v1/search?q=${encodeURIComponent(query)}&limit=10`, {
      headers: { Referer: `${REANIME_API}/` },
    });
    return (j.results || []).map(r => {
      // Search sometimes returns anilist_id=0; extract from cover_image URL
      // (pattern: /nx<anilist_id>-<hash>.jpg) as fallback.
      let anilistId = r.anilist_id;
      if (!anilistId && r.cover_image) {
        const url = r.cover_image.extra_large || r.cover_image.large || r.cover_image.medium || '';
        const m = url.match(/\/nx(\d+)-/);
        if (m) anilistId = parseInt(m[1]);
      }
      return {
        animeId: r.anime_id,
        anilistId,
        title: r.title?.english || r.title?.romaji || r.title?.native || 'Unknown',
        year: r.season_year,
        canWatch: r.can_watch,
      };
    });
  } catch (e) {
    console.log(`[ReAnime] search failed: ${e.message}`);
    return [];
  }
}

// Fetch anilist_id from the watch page's embedded SvelteKit payload (fallback
// when search returns anilist_id=0).
async function fetchAnimeMeta(animeId) {
  try {
    const html = await fetchText(`${REANIME_API}/watch/${animeId}?ep=1`, {
      headers: { Referer: `${REANIME_API}/` },
    });
    const m = html.match(/anilist_id:(\d+)/);
    if (m) return { anilistId: parseInt(m[1]) };
  } catch (e) {
    console.log(`[ReAnime] fetchAnimeMeta failed: ${e.message}`);
  }
  return null;
}

// ─── Find matching anime on reanime by title + year ─────────────────────────
async function findAnimeByTitle(title, year) {
  const queries = [
    title,
    title.replace(/\s*\(.*?\)\s*/g, '').trim(),
    title.split(/[:\-\u2013]/)[0].trim(),
  ].filter((q, i, a) => q && a.indexOf(q) === i);

  for (const q of queries) {
    const results = await searchReanime(q);
    if (results.length === 0) continue;
    const exact = results.find(r => r.title.toLowerCase() === title.toLowerCase());
    const yearMatch = year ? results.find(r => String(r.year) === String(year)) : null;
    const picked = exact || yearMatch || results[0];
    if (picked) {
      console.log(`[ReAnime] Matched: ${picked.title} (${picked.year}) anilist=${picked.anilistId} slug=${picked.animeId}`);
      return picked;
    }
  }
  return null;
}

// ─── FlixCloud decryption chain ──────────────────────────────────────────────
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function b64decode(s) { return Buffer.from(s, 'base64'); }
function b64encode(buf) { return Buffer.from(buf).toString('base64'); }
function match1(re, str) { const m = str.match(re); return m ? m[1] : null; }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Derive field-name map from the per-request obfuscation_seed.
// Mirrors the xn() function in flixcloud's 12.ynMYRcYB.js.
function deriveFieldNames(seed) {
  let e = seed;
  for (let o = 0; o < 3; o++) e = sha256Hex(e + o.toString());
  let a = e;
  for (let o = 0; o < 3; o++) a = sha256Hex(a + o.toString());
  return {
    containerName: `cd_${e.substring(24, 32)}`,
    arrayName:    `ad_${e.substring(32, 40)}`,
    objectName:   `od_${e.substring(40, 48)}`,
    keyField:     `kf_${e.substring(8, 16)}`,
    ivField:      `ivf_${e.substring(16, 24)}`,
    tokenField:   `${e.substring(48, 64)}_${e.substring(56, 64)}`,
    keyFrag2Field: `${a.substring(0, 16)}_${a.substring(16, 24)}`,
  };
}

// Cache compiled WASM modules per w_payload hash (the decryptor changes per
// 5-minute window but is reused across requests within that window).
const _wasmCache = new Map();
async function getWasm(wPayloadB64) {
  const key = crypto.createHash('sha256').update(wPayloadB64).digest('hex').slice(0, 16);
  if (_wasmCache.has(key)) return _wasmCache.get(key);
  const wasmBytes = b64decode(wPayloadB64);
  const mod = await WebAssembly.compile(wasmBytes);
  const inst = await WebAssembly.instantiate(mod, {});
  _wasmCache.set(key, inst);
  return inst;
}

// Resolve the full FlixCloud decryption chain for an accessId.
// Returns { masterUrl, xorKey (32-byte Buffer), videoId, videoTitle, accessId }.
async function resolveFlixcloud(accessId) {
  console.log(`[ReAnime] FlixCloud: fetching /e/${accessId}?v=2`);
  const r = await fetchBufNode(`${FLIXCLOUD}/e/${accessId}?v=2`);
  if (r.status !== 200) throw new Error(`flixcloud HTTP ${r.status}`);
  const html = r.body.toString('utf8');

  // Extract embedded payload fields.
  const seed = match1(/obfuscation_seed:"([^"]+)"/, html);
  const wPayloadB64 = match1(/w_payload:"([^"]+)"/, html);
  const videoTitle = match1(/video_title:"([^"]+)"/, html);
  const videoId = match1(/video_id:"([^"]+)"/, html);
  if (!seed || !wPayloadB64) throw new Error('flixcloud payload missing obfuscation_seed/w_payload');

  const fields = deriveFieldNames(seed);

  // Extract frag1_b64 + iv_b64 from obfuscated_crypto_data nested structure.
  const ocRe = new RegExp(
    `${esc(fields.containerName)}"?:\\s*\\{` +
    `${esc(fields.arrayName)}"?:\\s*\\[\\{` +
    `${esc(fields.objectName)}"?:\\s*\\{` +
    `[^}]*${esc(fields.keyField)}"?:\\s*"([^"]+)"` +
    `[^}]*${esc(fields.ivField)}"?:\\s*"([^"]+)"`
  );
  const ocMatch = html.match(ocRe);
  if (!ocMatch) throw new Error('failed to extract obfuscated_crypto_data');
  const frag1_b64 = ocMatch[1];
  const iv_b64 = ocMatch[2];

  // Find tokenField and keyFrag2Field values in the payload.
  const tokenValue = match1(new RegExp(`"?${esc(fields.tokenField)}"?\\s*:\\s*"([^"]+)"`), html);
  const keyFrag2 = match1(new RegExp(`"?${esc(fields.keyFrag2Field)}"?\\s*:\\s*"([^"]+)"`), html);
  if (!tokenValue || !keyFrag2) throw new Error('token/keyFrag2 not found in payload');

  // Fetch the per-token m3u8 manifest keys.
  console.log(`[ReAnime] FlixCloud: fetching /api/m3u8/${tokenValue}`);
  const m3u8Resp = await fetchBufNode(`${FLIXCLOUD}/api/m3u8/${tokenValue}`, {
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  if (m3u8Resp.status !== 200) throw new Error(`/api/m3u8 HTTP ${m3u8Resp.status}`);
  const m3u8Json = JSON.parse(m3u8Resp.body.toString('utf8'));

  const vidKey = sha256Hex(tokenValue + 'vid').substring(0, 10);
  const keyKey = sha256Hex(tokenValue + 'key').substring(0, 10);
  const vidB64 = m3u8Json[vidKey];
  const keyB64 = m3u8Json[keyKey];
  if (!vidB64 || !keyB64) throw new Error('vid/key missing in m3u8 token response');

  // WASM-derive the 32-byte key fragment O via kn(t, e, a, o).
  const v = parseInt(seed.substring(0, 8), 16);
  const inst = await getWasm(wPayloadB64);
  const ex = inst.exports;
  if (typeof ex._s !== 'function' || typeof ex._r !== 'function') {
    throw new Error('WASM missing _s/_r exports');
  }
  const t = b64decode(frag1_b64);
  const eBuf = b64decode(keyFrag2);
  const aBuf = b64decode(keyB64);
  const k = t.length;
  const I = 1000, P = I + k, U = P + k, nt = U + k;
  const needed = nt + k;
  if (ex.memory.buffer.byteLength < needed) {
    const pagesNeeded = Math.ceil((needed - ex.memory.buffer.byteLength) / 65536);
    ex.memory.grow(pagesNeeded);
  }
  const S = new Uint8Array(ex.memory.buffer);
  S.set(t, I);
  S.set(eBuf, P);
  S.set(aBuf, U);
  ex._s(v);
  ex._r(I, P, U, nt, k);
  const O = Buffer.from(S.subarray(nt, nt + k));

  // PBKDF2 → XOR with seed → SHA-256 → final 32-byte AES key.
  const W = crypto.pbkdf2Sync(O, Buffer.from(seed, 'utf8'), 1000, 32, 'sha256');
  const tt = Buffer.from(W);
  const seedBytes = Buffer.from(seed, 'utf8');
  for (let i = 0; i < 32; i++) tt[i] ^= seedBytes[i % seedBytes.length];
  const Nt = crypto.createHash('sha256').update(tt).digest();

  // AES-256-CBC decrypt the master.m3u8 URL.
  const iv = b64decode(iv_b64);
  const ct = b64decode(vidB64);
  const decipher = crypto.createDecipheriv('aes-256-cbc', Nt, iv);
  let decrypted = decipher.update(ct);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  const masterUrl = decrypted.toString('utf8');

  // Get the per-session XOR key via WASM _c() (this is window.__pk in the browser).
  // Used to decrypt the m3u8 playlist contents (base64 + XOR with __pk).
  let xorKey = null;
  if (typeof ex._c === 'function') {
    const cPtr = ex._c();
    xorKey = Buffer.from(new Uint8Array(ex.memory.buffer).slice(cPtr, cPtr + 32));
  }

  return { masterUrl, xorKey, videoId, videoTitle, accessId };
}

// ─── Resolve reanime.to streams for a TMDB ID ────────────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[ReAnime] Request: tmdb=${tmdbId} type=${type}` + (isTV ? ` S${season || '?'}E${episode || '?'}` : ''));

  // 1. Get TMDB info.
  const info0 = await getTMDBInfo(tmdbId, type);
  if (!info0) return [];
  console.log(`[ReAnime] TMDB: ${info0.title} (${info0.year})`);

  // 2. Find matching anime on reanime.to.
  let anime = await findAnimeByTitle(info0.title, info0.year);
  if (!anime) {
    console.log('[ReAnime] No matching anime found on reanime.to');
    return [];
  }
  // If anilist_id is missing/zero, fetch it from the watch page.
  if (!anime.anilistId) {
    console.log('[ReAnime] anilist_id missing — fetching from watch page...');
    const meta = await fetchAnimeMeta(anime.animeId);
    if (meta && meta.anilistId) {
      anime.anilistId = meta.anilistId;
    } else {
      console.log('[ReAnime] Could not determine anilist_id — aborting');
      return [];
    }
  }

  // 3. Determine episode number (reanime uses absolute numbering).
  const epNum = isTV && episode ? parseInt(episode) : 1;

  // 4. Fetch flixcloud server URLs.
  console.log(`[ReAnime] Fetching /api/flix/${anime.anilistId}/${epNum}`);
  let flixResp;
  try {
    flixResp = await fetchJson(`${REANIME_API}/api/flix/${anime.anilistId}/${epNum}`, {
      headers: { Referer: `${REANIME_API}/` },
    });
  } catch (e) {
    console.log(`[ReAnime] /api/flix failed: ${e.message}`);
    return [];
  }
  if (!flixResp.success || !Array.isArray(flixResp.servers) || flixResp.servers.length === 0) {
    console.log('[ReAnime] No servers returned by /api/flix');
    return [];
  }

  // 5. Resolve each FlixCloud URL → master.m3u8 + XOR key.
  const info = {
    ...info0,
    epLabel: isTV && season && episode ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '',
  };
  const allStreams = [];
  const seenUrls = new Set();
  for (const server of flixResp.servers) {
    const m = server.dataLink?.match(/\/e\/([a-zA-Z0-9_-]+)/);
    if (!m) continue;
    const accessId = m[1];

    let resolved;
    try {
      resolved = await resolveFlixcloud(accessId);
    } catch (e) {
      console.log(`[ReAnime]   ${server.serverName} (${accessId}): ${e.message.slice(0, 80)}`);
      continue;
    }
    console.log(`[ReAnime]   ${server.serverName} (${accessId}): master.m3u8 OK, xorKey=${resolved.xorKey ? 'yes' : 'no'}`);

    const xorKeyB64 = resolved.xorKey ? b64encode(resolved.xorKey) : '';
    const streamObj = {
      name: `${PROVIDER_NAME} [${server.serverName}] | 1080p | ${server.dataType}`,
      title: `${info.title}${info.year ? ` (${info.year})` : ''}${info.epLabel} [ReAnime ${server.serverName} ${server.dataType}]`,
      url: resolved.masterUrl,
      quality: '1080p',
      type: 'application/vnd.apple.mpegurl',
      behaviorHints: {
        bingeGroup: `reanime-${server.serverName}-${server.dataType}`,
        notWebReady: true,  // requires XOR-decrypt proxy to play
      },
      // Custom fields for the bundled proxy.
      reanime: {
        xorKeyB64,
        masterUrl: resolved.masterUrl,
        videoId: resolved.videoId,
        videoTitle: resolved.videoTitle,
        serverName: server.serverName,
        dataType: server.dataType,
        accessId,
      },
    };
    // Dedupe by master URL (HD-1 and HD-2 may share the same accessId).
    if (!seenUrls.has(streamObj.url)) {
      seenUrls.add(streamObj.url);
      allStreams.push(streamObj);
    }
  }

  console.log(`[ReAnime] ${allStreams.length} stream(s) total`);
  return allStreams;
}

// ─── Local XOR-decryption proxy ──────────────────────────────────────────────
// Starts an HTTP proxy that decrypts FlixCloud m3u8 playlists + segments and
// serves them as standard HLS to any client (Stremio, hls.js, ffmpeg, VLC).
//
// URL formats:
//   http://localhost:<port>/playlist.m3u8?url=<encoded>&key=<base64-32-byte-key>
//   http://localhost:<port>/seg.ts?url=<encoded>&e=.ts
//   http://localhost:<port>/?url=<encoded>&key=<base64-32-byte-key>   (legacy)
//
// The proxy auto-detects content type:
//   - WebP (RIFF....WEBP): strip 12 bytes, XOR with SEGMENT_XOR_KEY (16 bytes)
//   - PNG (\x89PNG\r\n\x1a\n): strip 8 bytes, XOR with SEGMENT_XOR_KEY
//   - Plain #EXTM3U: pass through (already decoded)
//   - Other: base64-decode + XOR with the 32-byte key (for encrypted m3u8)
async function startProxy(port = 7654) {
  const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // For HEAD requests, fetch the upstream and return headers only
    const isHead = req.method === 'HEAD';

    try {
      const u = new URL(req.url, 'http://localhost');
      const targetUrl = u.searchParams.get('url');
      const keyB64 = u.searchParams.get('key');
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        return;
      }
      // The 32-byte XOR key is only required for m3u8 playlist decryption.
      let xorKey = null;
      if (keyB64) {
        try {
          xorKey = Buffer.from(keyB64, 'base64');
          if (xorKey.length !== 32) xorKey = null;
        } catch (e) { xorKey = null; }
      }

      // Fetch the upstream URL with FlixCloud Referer.
      const r = await fetchBufNode(targetUrl, {
        headers: {
          'Referer': 'https://flixcloud.cc/',
          'Origin': 'https://flixcloud.cc',
          'Accept': '*/*',
        },
      });
      if (r.status !== 200) {
        res.writeHead(r.status, { 'Content-Type': 'text/plain' });
        res.end(`Upstream HTTP ${r.status}`);
        return;
      }

      const body = r.body;
      const bodyStr = body.toString('utf8');

      // Detect content type by inspecting the body bytes.
      let plaintext;
      let contentType;
      let isSegment = false;
      let isM3u8 = false;

      if (body.length >= 12 && body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46
          && body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50) {
        // WebP disguised segment — strip 12-byte header, XOR with 16-byte key.
        const payload = body.slice(12);
        plaintext = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) plaintext[i] = payload[i] ^ SEGMENT_XOR_KEY[i % 16];
        isSegment = true;
        contentType = 'video/mp2t';
      } else if (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4E && body[3] === 0x47
                 && body[4] === 0x0D && body[5] === 0x0A && body[6] === 0x1A && body[7] === 0x0A) {
        // PNG disguised segment — strip 8-byte header, XOR with 16-byte key.
        const payload = body.slice(8);
        plaintext = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) plaintext[i] = payload[i] ^ SEGMENT_XOR_KEY[i % 16];
        isSegment = true;
        contentType = 'video/mp2t';
      } else if (bodyStr.startsWith('#EXTM3U')) {
        // Plain m3u8 (already decoded).
        plaintext = body;
        isM3u8 = true;
        contentType = 'application/vnd.apple.mpegurl';
      } else if (xorKey) {
        // Encrypted m3u8 playlist (base64 + XOR with __pk 32-byte key).
        try {
          const decoded = Buffer.from(bodyStr, 'base64');
          plaintext = Buffer.alloc(decoded.length);
          for (let i = 0; i < decoded.length; i++) plaintext[i] = decoded[i] ^ xorKey[i % xorKey.length];
          if (plaintext.toString('utf8').startsWith('#EXTM3U')) {
            isM3u8 = true;
            contentType = 'application/vnd.apple.mpegurl';
          } else {
            plaintext = body;
            contentType = 'application/octet-stream';
          }
        } catch (e) {
          plaintext = body;
          contentType = 'application/octet-stream';
        }
      } else {
        plaintext = body;
        contentType = 'application/octet-stream';
      }

      // For HEAD requests, just return headers (no body).
      if (isHead) {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': plaintext.length,
          'Cache-Control': isSegment ? 'public, max-age=86400' : 'no-store',
        });
        res.end();
        return;
      }

      // For segments, stream the plaintext MPEG-TS directly.
      if (isSegment) {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': plaintext.length,
          'Cache-Control': 'public, max-age=86400',  // segments are immutable VOD
        });
        res.end(plaintext);
        return;
      }

      // For m3u8 playlists, rewrite URLs to route through the proxy.
      let rewritten = plaintext.toString('utf8');
      if (isM3u8) {
        const baseUrl = new URL(targetUrl);
        const basePath = baseUrl.pathname.replace(/\/[^/]*$/, '/');
        const baseOrigin = `${baseUrl.protocol}//${baseUrl.host}`;

        // Convert a relative URL to an absolute URL against the upstream.
        const toAbsolute = (line) => {
          if (line.startsWith('http://') || line.startsWith('https://')) return line;
          if (line.startsWith('//')) return baseUrl.protocol + line;
          if (line.startsWith('/')) return baseOrigin + line;
          if (line.startsWith('../')) {
            let path = basePath;
            let rest = line;
            while (rest.startsWith('../')) {
              path = path.replace(/[^/]*\/$/, '');
              rest = rest.substring(3);
            }
            return baseOrigin + path + rest;
          }
          return baseOrigin + basePath + line;
        };

        // Route a URL through the proxy if it's on flixcloud/atomic4cdn.
        // Uses path-based URLs with proper extensions so ffmpeg's HLS parser
        // accepts the segments (it rejects .webp/.png segment extensions).
        const toProxy = (absUrl) => {
          if (absUrl.includes('flixcloud.cc') || absUrl.includes('atomic4cdn.top')) {
            if (absUrl.endsWith('.webp') || absUrl.endsWith('.png')) {
              // `&e=.ts` makes ffmpeg treat the URL as a .ts segment.
              return `http://localhost:${port}/seg.ts?url=${encodeURIComponent(absUrl)}&e=.ts`;
            }
            if (absUrl.endsWith('.m3u8')) {
              return `http://localhost:${port}/playlist.m3u8?url=${encodeURIComponent(absUrl)}&key=${encodeURIComponent(keyB64)}`;
            }
            return `http://localhost:${port}/raw?url=${encodeURIComponent(absUrl)}&key=${encodeURIComponent(keyB64)}`;
          }
          return absUrl;
        };

        // 1. Rewrite URI="..." attributes inside #EXT-X-MEDIA and #EXT-X-KEY tags.
        rewritten = rewritten.replace(/(URI=")([^"]+)(")/g, (m, prefix, url, suffix) =>
          prefix + toProxy(toAbsolute(url)) + suffix);

        // 2. Rewrite standalone URL lines (variant playlists, segments).
        rewritten = rewritten.replace(/(^[^#\n].*$)/gm, (line) => {
          if (!line.trim() || line.startsWith('#')) return line;
          return toProxy(toAbsolute(line.trim()));
        });

        // Remove AES-128 KEY directives (FlixCloud segments are XOR-encrypted, not AES).
        rewritten = rewritten.replace(/^#EXT-X-KEY:METHOD=AES-128.*$/gm, '');
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(rewritten);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${e.message}`);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[ReAnime] XOR-decryption proxy listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}

// ─── Generate proxy URL for a stream (convenience helper) ───────────────────
function getProxyUrl(stream, port = 7654) {
  if (!stream || !stream.reanime) return null;
  const enc = encodeURIComponent(stream.reanime.masterUrl);
  const key = encodeURIComponent(stream.reanime.xorKeyB64);
  return `http://localhost:${port}/playlist.m3u8?url=${enc}&key=${key}`;
}

// ─── Module exports ─────────────────────────────────────────────────────────
module.exports = {
  getStreams, getTMDBInfo, searchReanime, findAnimeByTitle,
  resolveFlixcloud, deriveFieldNames, startProxy, getProxyUrl,
  REANIME_API, FLIXCLOUD, PROVIDER_NAME, SEGMENT_XOR_KEY,
};

// ─── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('ReAnime.to Direct Stream Extractor');
    console.log('  Anime + Movies — direct playable HLS via FlixCloud (with XOR-decrypt proxy)');
    console.log('');
    console.log('Usage:');
    console.log('  node reanime_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('  node reanime_all_in_one.js search "haikyuu"');
    console.log('  node reanime_all_in_one.js proxy [port]');
    console.log('');
    console.log('Examples:');
    console.log('  node reanime_all_in_one.js 71014 tv 1 1     # Sagrada Reset S01E01');
    console.log('  node reanime_all_in_one.js 60863 tv 1 1     # HAIKYU!! S01E01');
    console.log('  node reanime_all_in_one.js proxy 7654       # Start XOR-decrypt proxy');
    process.exit(1);
  }

  if (args[0] === 'search') {
    searchReanime(args[1]).then(r => {
      console.log('\n=== Search results ===');
      r.forEach((x, i) => console.log(`${i+1}. ${x.title} (${x.year}) | anilist=${x.anilistId} | slug=${x.animeId} | canWatch=${x.canWatch}`));
    }).catch(e => { console.error(e); process.exit(1); });
  } else if (args[0] === 'proxy') {
    const port = parseInt(args[1] || '7654');
    startProxy(port).then(() => {
      console.log(`\nTest: curl "http://localhost:${port}/playlist.m3u8?url=<encoded>&key=<base64-key>"`);
      console.log('Press Ctrl+C to stop.');
    }).catch(e => { console.error(e); process.exit(1); });
  } else {
    getStreams(args[0], args[1], args[2], args[3])
      .then(s => {
        console.log('\n=== Final playable streams ===');
        if (s.length === 0) { console.log('No streams found.'); return; }
        s.forEach((x, i) => {
          console.log(`${i+1}. ${x.name}`);
          console.log(`   URL: ${x.url.slice(0, 180)}${x.url.length > 180 ? '...' : ''}`);
          if (x.reanime) {
            console.log(`   XOR Key: ${x.reanime.xorKeyB64}`);
            console.log(`   Server: ${x.reanime.serverName} (${x.reanime.dataType})`);
          }
        });
        console.log(`\nTotal: ${s.length}`);
        console.log('\nTo play:');
        console.log('  1. Start the proxy:  node reanime_all_in_one.js proxy');
        console.log('  2. Use this URL with any HLS client (VLC, mpv, ffmpeg, Stremio):');
        const proxyUrl = getProxyUrl(s[0]);
        if (proxyUrl) console.log(`     ${proxyUrl.slice(0, 200)}...`);
        console.log('\n  ffmpeg example:');
        console.log('    ffmpeg -protocol_whitelist "file,http,https,tcp,tls,crypto,data" \\');
        console.log('           -allowed_extensions ALL \\');
        console.log('           -i "<proxy-url>" -t 60 -c copy output.mp4');
      })
      .catch(e => { console.error('FATAL: ' + e.stack); process.exit(1); });
  }
}
