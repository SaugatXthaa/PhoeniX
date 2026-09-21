// src/nuvio/atlantic.cjs — Atlantic (atlantic.st) provider (Task 48 rewrite; Task 55 budget fix)
//
// Reverse engineering trail (verified live 2026-09-17):
//   https://atlantic.st/            → React SPA (Vite build), TMDB-driven catalog.
//                                     Player code lives in assets/index-BWLBkgfa.js;
//                                     request signing in assets/aphrodite-gate-*.js.
//   Stream servers (2, verbatim from the bundle):
//     Artemis   — GET https://stellar.hls.lol/resolve
//                   ?tmdbId=<tmdb>&type=movie|tv[&season=&episode=]
//                 → {found, format:"hls", source:"Orbit"|"Nova", url}
//                 NO signing. The server picks the source itself (the
//                 availableSources array is informational; a &source= param is
//                 ignored — verified). Orbit = movies/TV fMP4 up to 2160p with
//                 separate audio groups; Nova = anime/TV muxed up to 1080p.
//     Aphrodite — GET https://cdn.hls.lol/content/movie/<tmdb>
//                             https://cdn.hls.lol/content/tv/<tmdb>/<s>/<e>
//                 → {found, type:"hls", hls?|url, title, renew?}
//                 CURATED content (spotty coverage — Dune2/BB yes, Inception no)
//                 single 4K variant master. SIGNED — aphrodite.a.v1 gate:
//
//   Gate protocol (deobfuscated from aphrodite-gate-BsVicaYl.js, webcrack):
//     seed[W]    = M[b + W*2] ^ X[W]                      (M=64B table, X=32B, b=1, s=2)
//     masterKey  = SHA256("aphrodite.a.v1" || seed)
//     session    = POST /content/index {c:"a", ts, n:<8B hex>, s:HMAC(masterKey,"a|ts|n")}
//                  → {d:<hex>} = AES-256-GCM(iv 12B || ct || tag 16B) with masterKey
//                  → JSON {sid, skey:<hex>, exp}
//     per request: X-A-Sid, X-A-Ts, X-A-Nonce(8B hex),
//                  X-A-Sig = HMAC-SHA256(skey, sid|path|ts|nonce)   (path ONLY)
//     client resets the session on response renew:true (mirror: also on 401/403)
//
//   CDN hotlink gates (verified live): both peraspera.nbsycfzrpa4.workers.dev
//   (Artemis) and totallyacdn.org (Aphrodite) answer 200 text/html decoys to
//   UA-only requests — they require Origin/Referer https://atlantic.st. Cards
//   carry headers {Origin, Referer, User-Agent} → NuvioExtractor routes them
//   through /proxy with referer= + origin= (+ forceHls=1, URLs are ambiguous)
//   and the proxy propagates both onto the whole rewritten m3u8 tree.
//
//   SUBTITLES (Task 55 change): REMOVED from this scraper. The addon's unified
//   subtitle stack (src/utils/siteSubtitles.cjs — the SAME granite+natsuki
//   providers, Fetcher-backed) runs once per title in StreamResolver and is
//   merged into EVERY source's cards. Keeping a second inline copy here only
//   duplicated upstream load inside Atlantic's critical path — production
//   evidence (Task 55): the inline natsuki stage burned 2×5s in bare-fetch DNS
//   stalls while the unified module (via Fetcher) delivered 48 tracks, pushing
//   Atlantic past the 13s client budget → ZERO Atlantic cards in responses.
//
// Task 55 deadline architecture: every stage is raced against a shared
// deadline (default 10.5s, under the 13s client budget) so getStreams ALWAYS
// RETURNS instead of being cut off by the client budget with nothing. The
// wrapper's empty-retry is elapsed-capped so a slow first attempt cannot
// double the wall time past the budget.
//
// Metadata honesty: quality labels come from parsed master RESOLUTION lines,
// server names (Artemis/Orbit/Nova/Aphrodite) from the site's own bundle,
// audio-track counts from EXT-X-MEDIA lines. Nothing guessed, no fabricated
// sizes (HLS byte totals are not estimable — same policy as cineby Task 40).

'use strict';

const crypto = require('crypto');

const ATLANTIC_ORIGIN = 'https://atlantic.st';
// Task 57 (2026-09-19): the whole Atlantic backend family migrated hosts —
// maybeoneday.ch is DOWN site-wide (stellar: connection timeout; natsuki/cdn:
// connection refused — DNS resolves, servers dead). The live site bundle
// (assets/index-ZCPe39OT.js + aphrodite-gate-BsVicaYl.js) now points at the
// hls.lol family: cdn.hls.lol (Aphrodite), stellar.hls.lol/resolve (Artemis,
// verified 200 live with sources Orbit/Nova/Astra). Gate scheme unchanged —
// same aphrodite.a.v1 HMAC/AES-GCM bootstrap, verified against the new host.
const CDN = 'https://cdn.hls.lol';
const ARTEMIS = 'https://stellar.hls.lol/resolve';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Origin': ATLANTIC_ORIGIN,
  'Referer': `${ATLANTIC_ORIGIN}/`,
};

// Task 55: per-fetch cap. Warm measurements: resolve ~0.5-1.1s, master ~0.3-0.6s,
// child validation ~0.4-0.9s. Caps keep the serial chain (resolve → master →
// validate) inside the shared 10.5s deadline even when both attempts fire:
// artemis resolve 2×4.5s + 0.4s backoff = 9.4s worst < 10.5s deadline.
const MASTER_TIMEOUT_MS = 6500;
const RESOLVE_TIMEOUT_MS = 4500;

// Task 48→60 history: Cloudflare 429-gates datacenter IPs (incl. Render's) on
// the payload workers — INTERMITTENTLY (Render passed at 03:5x, 429'd at
// 04:1x on 2026-09-19). Task 60 RETIRES the old "ship direct with
// requestHeaders" doctrine: live verification showed peraspera AND
// totallyacdn 302 a HEADERLESS request to a YouTube trailer (yqr1BnpY628),
// and iOS players never send custom headers — so direct shipping hung every
// card at "loading". Cards now ship ONLY when they validate from our IP and
// always through the addon /proxy (origin+referer injected; see wrapArtemis
// in getStreams). isDatacenterGated survives only as documentation.
const DATACENTER_GATE_HOST_RE = /(^|\.)workers\.dev$/i;
function isDatacenterGated(url) {
  try { return DATACENTER_GATE_HOST_RE.test(new URL(url).hostname); } catch { return false; }
}
void isDatacenterGated;

// Production evidence (Render 0.1 CPU, Task 48 deploy day): under resolve
// storms all upstream stages can fail SIMULTANEOUSLY (~3.3s) — the
// DNS-resolver/socket hiccup class, since the same hosts answer 200 via
// /debug/rawfetch and /proxy from the same instance seconds later. A single
// fast retry per call absorbs it. HTTP-status answers (404/403/429/5xx) are
// REAL answers — returned as-is, never retried.
//
// Task 55: when the caller provides the addon Fetcher (preloaded.fetcher +
// preloaded.ctx), all GETs route through it — family:4 forced, node-level
// timeout, got-scraping CF fallback. Bare undici fetch hangs on Render during
// resolve storms past AbortSignal deadlines (the documented DNS-stall class —
// Task 55 measured it killing the natsuki stage at 2×5s while the Fetcher path
// returned 48 items in <1s). Bare fetch remains the fallback (local tooling).
async function ftext(url, { headers = {}, timeoutMs = MASTER_TIMEOUT_MS, fetcher, ctx, attempts = 2, tag = '' } = {}) {
  // → { ok, status, data } — never throws
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 400));
    if (fetcher && ctx) {
      try {
        const r = await fetcher.fetchWithTimeout(ctx, new URL(url), { timeout: timeoutMs, headers });
        return { ok: r.status >= 200 && r.status < 300, status: r.status, data: String(r.data || '') };
      } catch (e) {
        const status = e?.statusCode || 0;
        console.log(`[Atlantic] fetcher fail${tag ? ` (${tag})` : ''} attempt ${i + 1}/${attempts}: ${e?.constructor?.name || ''} ${e?.message || e} (${url.slice(0, 70)})`);
        // Real HTTP answers are not retried (404 = not-found, 403 = gated,
        // 429 = datacenter gate — the ipGated advisory logic handles them).
        if (status >= 400) return { ok: false, status, data: '' };
        continue; // network-level error → one fast retry
      }
    }
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const data = await res.text();
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      console.log(`[Atlantic] fetch fail${tag ? ` (${tag})` : ''} attempt ${i + 1}/${attempts}: ${e?.message || e} (${url.slice(0, 70)})`);
    }
  }
  return { ok: false, status: 0, data: '' };
}

// ─── Aphrodite gate (aphrodite.a.v1) ───
const GATE_M = new Uint8Array([152, 159, 215, 12, 139, 229, 103, 92, 79, 156, 87, 240, 161, 70, 97, 40, 218, 79, 171, 72, 9, 177, 171, 147, 62, 249, 164, 146, 201, 90, 184, 204, 237, 159, 162, 35, 55, 32, 234, 114, 164, 188, 27, 63, 151, 213, 4, 92, 117, 56, 136, 58, 252, 220, 222, 69, 186, 144, 227, 223, 214, 102, 114, 251]);
const GATE_X = new Uint8Array([223, 178, 166, 138, 172, 171, 123, 225, 225, 38, 113, 78, 41, 179, 108, 148, 174, 227, 135, 224, 100, 253, 252, 79, 116, 151, 43, 67, 103, 203, 90, 249]);
const GATE_LABEL = 'a';
const GATE_UA_STRING = 'aphrodite.a.v1';

const gateSeed = (() => {
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = GATE_M[1 + i * 2] ^ GATE_X[i];
  return out;
})();
const gateMasterKey = crypto.createHash('sha256')
  .update(Buffer.concat([Buffer.from(GATE_UA_STRING, 'utf8'), gateSeed]))
  .digest();

let gateSession = null;       // { sid, skey:<Buffer>, exp }
let gateInFlight = null;      // single-flight bootstrap

function gateReset() {
  gateSession = null;
}

// POST is not supported by the addon Fetcher (no body option) — bare fetch.
async function gateBootstrap() {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', gateMasterKey).update(`${GATE_LABEL}|${ts}|${nonce}`).digest('hex');
  const res = await fetch(`${CDN}/content/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({ c: GATE_LABEL, ts, n: nonce, s: sig }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`gate bootstrap HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !j.d) throw new Error('gate bootstrap missing payload');
  const blob = Buffer.from(j.d, 'hex');
  if (blob.length < 28) throw new Error('gate payload too short');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', gateMasterKey, iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
  const obj = JSON.parse(plain.toString('utf8'));
  if (!obj || !obj.sid || !obj.skey) throw new Error('gate session missing fields');
  return { sid: String(obj.sid), skey: Buffer.from(String(obj.skey), 'hex'), exp: Number(obj.exp) || 0 };
}

async function gateGetSession() {
  const now = Math.floor(Date.now() / 1000);
  if (gateSession && gateSession.exp - now > 60 && gateSession.skey.length === 32) return gateSession;
  if (!gateInFlight) {
    gateInFlight = gateBootstrap()
      .then((s) => { gateSession = s; return s; })
      .finally(() => { gateInFlight = null; });
  }
  return gateInFlight;
}

function gateSignHeaders(sess, path) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', sess.skey).update(`${sess.sid}|${path}|${ts}|${nonce}`).digest('hex');
  return {
    'X-A-Sid': sess.sid,
    'X-A-Ts': String(ts),
    'X-A-Nonce': nonce,
    'X-A-Sig': sig,
  };
}

// Signed GET — one renew/401/403-triggered session reset + retry (mirrors the
// client's renew flow; the wasm-less sibling of cinejoy's 404→refresh-retry).
// Task 71 (2026-09-21): the site DISABLED/removed the aphrodite.a.v1 gate —
// POST /content/index (bootstrap) now answers 403 {"error":"forbidden"}
// (verified 3/3 from sandbox) while the content endpoints answer PLAIN
// unsigned GETs with {found:true,...} (verified 200 from sandbox AND from
// Render egress via the addon /proxy). When the signed path fails at the
// bootstrap stage, fall back to the unsigned GET so Aphrodite keeps
// delivering through their gate migration instead of honest-zeroing.
async function gateGet(path, fetcher, ctx) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let sess;
    try {
      sess = await gateGetSession();
    } catch (e) {
      console.log(`[Atlantic] gate bootstrap unavailable (${e?.message || e}) — unsigned fallback`);
      return unsignedGateGet(path, fetcher, ctx); // gate gone — plain GET still serves content
    }
    const r = await ftext(`${CDN}${path}`, {
      headers: { ...gateSignHeaders(sess, path), ...HEADERS }, fetcher, ctx, attempts: 1, tag: 'gate',
    });
    if (r.status === 401 || r.status === 403) {
      gateReset();
      continue; // fresh session, retry once
    }
    if (!r.ok) return r; // 404 = not on Aphrodite (curated catalog)
    if (!r.data || r.data[0] !== '{') return { ok: false, status: r.status, data: '' };
    let j;
    try { j = JSON.parse(r.data); } catch { return { ok: false, status: r.status, data: '' }; }
    if (j.renew === true) {
      gateReset();
      if (attempt === 0) continue;
      return { ok: false, status: r.status, data: '' };
    }
    return { ok: true, status: r.status, json: j };
  }
  return { ok: false, status: 0, data: '' };
}

// Unsigned GET of a gate-path — Task 71 fallback (see gateGet above).
function unsignedGateGet(path, fetcher, ctx) {
  return ftext(`${CDN}${path}`, { headers: HEADERS, fetcher, ctx, attempts: 1, tag: 'aph-plain' })
    .then((r) => {
      if (!r.ok) return r;
      if (!r.data || r.data[0] !== '{') return { ok: false, status: r.status, data: '' };
      try { return { ok: true, status: r.status, json: JSON.parse(r.data) }; }
      catch { return { ok: false, status: r.status, data: '' }; }
    });
}

// ─── Stream servers ───

async function resolveArtemis(tmdbId, type, season, episode, fetcher, ctx) {
  const q = new URLSearchParams();
  q.set('tmdbId', String(tmdbId));
  q.set('type', type);
  if (type === 'tv') {
    q.set('season', String(season || 1));
    q.set('episode', String(episode || 1));
  }
  const r = await ftext(`${ARTEMIS}?${q.toString()}`, { headers: HEADERS, timeoutMs: RESOLVE_TIMEOUT_MS, fetcher, ctx, attempts: 2, tag: 'artemis' });
  if (!r.ok) return null;
  let j;
  try { j = JSON.parse(r.data); } catch { return null; }
  if (!j || j.found !== true || typeof j.url !== 'string' || !/^https?:\/\//.test(j.url)) return null;
  return { url: j.url, server: String(j.source || 'Artemis') };
}

async function resolveAphrodite(tmdbId, type, season, episode, fetcher, ctx) {
  const path = type === 'tv'
    ? `/content/tv/${tmdbId}/${season || 1}/${episode || 1}`
    : `/content/movie/${tmdbId}`;
  const r = await gateGet(path, fetcher, ctx);
  if (!r.ok || !r.json || r.json.found !== true) return null;
  const j = r.json;
  const url = (typeof j.hls === 'string' && j.hls) || (j.type === 'hls' && typeof j.url === 'string' ? j.url : '');
  if (!url || !/^https?:\/\//.test(url)) return null;
  return { url, server: 'Aphrodite', title: typeof j.title === 'string' ? j.title : '' };
}

// ─── Master playlist parsing ───
// Returns { variants:[{h, bw, codecs, uri}], audioTracks:[names], separateAudio }
function parseMaster(text) {
  const lines = String(text || '').split('\n');
  const variants = [];
  const audioTracks = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.startsWith('#EXT-X-MEDIA:')) {
      if (/TYPE=AUDIO/.test(L)) {
        const name = /NAME="([^"]*)"/.exec(L)?.[1];
        if (name) audioTracks.push(name);
      }
      continue;
    }
    if (L.startsWith('#EXT-X-STREAM-INF:')) {
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(L);
      const bw = /BANDWIDTH=(\d+)/.exec(L);
      const codecs = /CODECS="([^"]*)"/.exec(L)?.[1] || '';
      let uri = '';
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim() && !lines[k].startsWith('#')) { uri = lines[k].trim(); break; }
      }
      if (uri) variants.push({ h: res ? parseInt(res[2], 10) : 0, bw: bw ? parseInt(bw[1], 10) : 0, codecs, uri });
    }
  }
  return {
    variants: variants.sort((a, b) => b.h - a.h || b.bw - a.bw),
    audioTracks,
    separateAudio: audioTracks.length > 0,
  };
}

// Muxed check: every variant declares an audio codec inside CODECS (Nova style:
// "mp4a.40.2,avc1.640028") → children carry their own audio → per-variant
// cards are safe. Separated-audio masters (AUDIO="audio" group, video-only
// children — verified: Orbit init segments carry a video trak only) MUST ship
// as the master so players keep the audio-group context.
function isMuxedVariants(parsed) {
  if (parsed.separateAudio) return false;
  if (parsed.variants.length === 0) return false;
  return parsed.variants.every(v => /mp4a|ac-3|ec-3|opus|vorbis/i.test(v.codecs));
}

// ─── Live validation ("only add if it works") ───
// Upstream serves decoy/stub manifests in some windows (verified live: the
// Aphrodite Dune2 payload returned a 345-byte 8-segment TS stub whose
// root-relative segment URLs 400 — unplayable on the real site too). Cards are
// shipped ONLY when the exact bytes players will need validate.

// A child/variant playlist must be an m3u8 with at least one playable line.
async function validatePlaylistChild(url, fetcher, ctx) {
  const r = await ftext(url, { headers: HEADERS, fetcher, ctx, attempts: 1, tag: 'child' });
  if (!r.ok) return false;
  if (!r.data.startsWith('#EXTM3U')) return false;
  return r.data.split('\n').some(l => l.trim() && !l.startsWith('#'));
}

// First bytes of a media segment — TS sync byte or fMP4 box magic. Bare fetch
// with a Range + body-cancel (NOT the addon Fetcher: it buffers the whole body,
// and a Range-hostile CDN would mean a full multi-MB segment download).
async function probeSegmentMagic(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MASTER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Range: 'bytes=0-4095' }, signal: ac.signal });
    if (!res.ok && res.status !== 206) return false;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    try { await reader.cancel(); } catch { /* already closed */ }
    if (!value || value.length < 4) return false;
    if (value[0] === 0x47 && value[188] === 0x47) return true; // MPEG-TS
    const magic = value.subarray(4, 8).toString('latin1');
    return magic === 'ftyp' || magic === 'styp' || magic === 'moov'; // fMP4/MP4
  } catch { return false; } finally { clearTimeout(timer); }
}

function qualityLabel(h) {
  if (h >= 2160) return '2160p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h > 0) return `${h}p`;
  return 'Auto';
}

// ─── TMDB fallback (wrapper normally preloads title/year/imdbId) ───
async function getTmdbMeta(tmdbId, mediaType, fetcher, ctx) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const key = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';
  const r = await ftext(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${key}&append_to_response=external_ids`, {
    timeoutMs: 8000, fetcher, ctx, attempts: 1, tag: 'tmdb',
  });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.data);
    return {
      title: (type === 'tv' ? j.name : j.title) || '',
      year: ((type === 'tv' ? j.first_air_date : j.release_date) || '').slice(0, 4),
      imdbId: j.external_ids?.imdb_id || '',
    };
  } catch { return null; }
}

// ─── Main ───
// getStreams(tmdbId, mediaType, season, episode, preloaded)
// preloaded: { title, year, imdbId, hostUrl, fetcher, ctx }
//   - hostUrl: enables /proxy-wrapped sub URLs (unused since Task 55 — kept
//     for wrapper compatibility)
//   - fetcher + ctx: route all upstream GETs through the addon Fetcher
//     (Task 55 — kills the Render bare-fetch DNS-stall class in-budget)
// Returns nuvio stream objects for buildStreamResults. Cards carry NO
// subtitles field — StreamResolver merges the unified granite+natsuki set
// (the SAME providers the site uses) into every source's cards.
async function getStreams(tmdbId, mediaType, season, episode, preloaded) {
  try {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const id = parseInt(tmdbId, 10);
    if (!id) return [];

    const fetcher = preloaded?.fetcher || null;
    const ctx = preloaded?.ctx || null;

    let imdbId = preloaded?.imdbId || '';
    if (!imdbId) {
      const meta = await getTmdbMeta(id, type, fetcher, ctx);
      if (meta?.imdbId) imdbId = meta.imdbId;
    }

    // Task 55: SHARED DEADLINE. Everything is raced against it so this
    // function always RETURNS (with whatever validated in time) instead of
    // being truncated by the resolver's client budget with zero cards.
    const DEADLINE_MS = Math.max(4000, parseInt(process.env.ATLANTIC_DEADLINE_MS, 10) || 10500);
    const t0 = Date.now();
    const remainingMs = () => DEADLINE_MS - (Date.now() - t0);
    const withDeadline = (p) => Promise.race([
      p.catch(() => null),
      new Promise(r => setTimeout(() => r(null), Math.max(250, remainingMs()))),
    ]);

    const timed = (label, v) => {
      const desc = v === null || v === undefined ? 'null'
        : Array.isArray(v) ? `${v.length} items`
        : (v && v.kind) ? v.kind : 'ok';
      console.log(`[Atlantic] ${label}: ${desc} +${Date.now() - t0}ms`);
      return v;
    };

    // — Artemis (Orbit/Nova): resolve → master parse, deadline-raced —
    const artemisChain = (async () => {
      const a = await resolveArtemis(id, type, season, episode, fetcher, ctx);
      if (!a) return null;
      const r = await ftext(a.url, { headers: HEADERS, fetcher, ctx, attempts: 1, tag: 'artemis-master' });
      if (r.ok && r.data.startsWith('#EXTM3U')) {
        // flatBody: raw master kept for the Task 71 flat-media-playlist branch
        return { ...a, parsed: parseMaster(r.data), masterOk: true, flatBody: r.data };
      }
      // Master fetch failed from OUR IP. Task 60: the old "advisory" card
      // (direct + requestHeaders) is now known-broken — headerless player
      // requests get 302'd to a YouTube trailer by the payload workers (iOS
      // never sends custom headers), so an advisory card = stuck-on-loading.
      // When the gate passes, the parsed branch below ships a fully-validated
      // /proxy-wrapped card instead. Drop honestly otherwise.
      console.log(`[Atlantic] artemis master failed (${r.status}) — dropping (no advisory)`);
      return null;
    })();

    // — Aphrodite: gate-signed resolve → master parse, deadline-raced —
    const aphroditeChain = (async () => {
      const a = await resolveAphrodite(id, type, season, episode, fetcher, ctx);
      if (!a) return null;
      const r = await ftext(a.url, { headers: HEADERS, fetcher, ctx, attempts: 1, tag: 'aphrodite-master' });
      if (!r.ok || !r.data.startsWith('#EXTM3U')) return null;
      return { ...a, body: r.data, parsed: parseMaster(r.data) };
    })();

    const [artemisMaster, aphroditeMaster] = await Promise.all([
      withDeadline(artemisChain).then(v => timed('artemis', v)),
      withDeadline(aphroditeChain).then(v => timed('aphrodite', v)),
    ]);

    // Task 60: peraspera payload masters 302 → a YouTube trailer whenever the
    // request lacks Origin/Referer (verified live: browser-UA-only curl → 302
    // youtube.com/watch; same URL with Origin+Referer → 200 #EXTM3U master;
    // payload TTL ≥ 40min, far above this source's 10min cache). iOS players
    // NEVER send custom headers, so the previous direct-with-requestHeaders
    // shipping hung every artemis card on the trailer redirect = "stuck on
    // loading". Ship the payload through the addon's OWN /proxy instead: the
    // proxy injects origin+referer upstream and rewriteM3u8Urls re-attaches
    // them onto every (absolute) peraspera child URL, so the whole tree
    // authenticates from Render without any player-side header support.
    const SELF_ORIGIN = String(preloaded?.hostUrl || '').replace(/\/+$/, '');
    // Wrap BOTH payload-CDN hosts: peraspera (Artemis/Orbit) and totallyacdn
    // (Aphrodite's current CDN) — both 302 headerless requests to a YouTube
    // trailer, so player-side fetch is never viable; the proxy injects the
    // Origin/Referer the workers demand onto the whole rewritten tree.
    const wrapArtemis = (u) => {
      if (!SELF_ORIGIN || !u) return u;
      if (!/peraspera\.nbsycfzrpa4\.workers\.dev|(^|\.)totallyacdn\.org/i.test(u)) return u;
      return `${SELF_ORIGIN}/proxy?url=${encodeURIComponent(u)}` +
        `&origin=${encodeURIComponent('https://atlantic.st')}` +
        `&referer=${encodeURIComponent('https://atlantic.st/')}` +
        `&hls=1`;
    };

    const streams = [];
    const seen = new Set();
    const push = (url, quality, title, ipGated = false) => {
      if (!url || !/^https?:\/\//.test(url)) return;
      const finalUrl = wrapArtemis(url);
      if (seen.has(finalUrl)) return;
      seen.add(finalUrl);
      streams.push({
        url: finalUrl,
        quality,
        title,
        name: 'Atlantic',
        headers: HEADERS,
        // Task 60: artemis cards now ride the addon /proxy (wrapArtemis) —
        // the old ipGated→direct-with-headers mapping no longer applies (a
        // /proxy URL cannot match the raw stream map in the wrapper, and
        // proxy-injected headers work from any player).
      });
    };

    // — Artemis (Orbit/Nova) —
    if (artemisMaster) {
      if (artemisMaster.parsed) {
        const { variants, audioTracks, separateAudio } = artemisMaster.parsed;
        if (variants.length > 0) {
          const maxH = variants[0].h;
          const audioNote = audioTracks.length > 1
            ? `, ${audioTracks.length} audio tracks (player audio menu)`
            : (audioTracks.length === 1 ? ', 1 audio track' : '');
          const ipGated = false; // Task 60: gate passed (master parsed) — strict validation, /proxy-wrapped ship
          if (separateAudio || !isMuxedVariants(artemisMaster.parsed)) {
            // Master card — players pick quality (and audio) natively. Children
            // are video-only renditions here; bare variant URLs would be silent.
            const topChildOk = variants[0].uri ? await withDeadline(validatePlaylistChild(variants[0].uri, fetcher, ctx)) : false;
            console.log(`[Atlantic] artemis top-child validation: ${topChildOk ? 'ok' : 'FAIL'} +${Date.now() - t0}ms`);
            if (topChildOk) {
              push(artemisMaster.url, qualityLabel(maxH), `${artemisMaster.server} — Auto (up to ${qualityLabel(maxH)})${audioNote}`, ipGated);
            }
          } else {
            // Muxed children — per-variant cards, strictly validated then
            // /proxy-wrapped by push().
            const perH = new Map();
            for (const v of variants) { if (!perH.has(v.h) || perH.get(v.h).bw < v.bw) perH.set(v.h, v); }
            const top = [...perH.values()].sort((a, b) => b.h - a.h).slice(0, 4);
            const verdicts = await Promise.all(top.map(v => withDeadline(validatePlaylistChild(v.uri, fetcher, ctx))));
            top.forEach((v, i) => {
              if (verdicts[i]) push(v.uri, qualityLabel(v.h), `${artemisMaster.server} — ${qualityLabel(v.h)}`, ipGated);
            });
          }
        } else if (/#EXTINF/.test(artemisMaster.flatBody || '')) {
          // Task 71: FLAT media playlist (no #EXT-X-STREAM-INF) — the edge
          // serving format the upstream migrated to (verified live: Dune 2
          // resolves to atlantic.st/edge-*/index.m3u8, 345-byte 8-segment VOD
          // whose segments answer 206 video/mp2t headerless). The variant-only
          // branch above silently skipped this class → artemis honest-zeroed
          // production-wide. Validate the first segment's magic bytes exactly
          // like the aphrodite flat path below, then ship the master (players
          // resolve the relative segment URLs against the master URL; the edge
          // host answers headerless so no /proxy wrap is needed).
          const flatBody = artemisMaster.flatBody || '';
          const firstSeg = flatBody.split('\n')
            .map(l => l.trim()).find(l => l && !l.startsWith('#'));
          let segUrl = null;
          try { if (firstSeg) segUrl = new URL(firstSeg, artemisMaster.url).href; } catch { segUrl = null; }
          const segOk = segUrl ? await withDeadline(probeSegmentMagic(segUrl)) : false;
          console.log(`[Atlantic] artemis media-playlist validation: ${segOk ? 'ok' : 'FAIL'} +${Date.now() - t0}ms`);
          if (segOk) {
            push(artemisMaster.url, 'Auto', `${artemisMaster.server} — Auto`);
          }
        }
      }
      // Task 60: the old unvalidated advisory push for unparseable gated
      // masters is REMOVED — a card that cannot be validated from our IP
      // cannot be validated at all (payload workers trailer-redirect
      // headerless player requests), so it never ships blind again.
    }

    // — Aphrodite —
    if (aphroditeMaster && aphroditeMaster.parsed) {
      const { variants, audioTracks } = aphroditeMaster.parsed;
      if (variants.length > 0) {
        // Real master (probed earlier: single 2160p variant + audio group)
        const topChildOk = variants[0].uri ? await withDeadline(validatePlaylistChild(variants[0].uri, fetcher, ctx)) : false;
        if (topChildOk) {
          const audioNote = audioTracks.length > 1 ? `, ${audioTracks.length} audio tracks` : '';
          push(aphroditeMaster.url, qualityLabel(variants[0].h), `Aphrodite — ${qualityLabel(variants[0].h)}${audioNote}`);
        }
      } else if (/#EXTINF/.test(aphroditeMaster.body)) {
        // Flat media playlist — validate first segment before shipping
        const firstSeg = aphroditeMaster.body.split('\n')
          .map(l => l.trim()).find(l => l && !l.startsWith('#'));
        let segUrl = null;
        try { if (firstSeg) segUrl = new URL(firstSeg, aphroditeMaster.url).href; } catch { segUrl = null; }
        const segOk = segUrl ? await withDeadline(probeSegmentMagic(segUrl)) : false;
        console.log(`[Atlantic] aphrodite media-playlist validation: ${segOk ? 'ok' : 'FAIL'} +${Date.now() - t0}ms`);
        if (segOk) {
          push(aphroditeMaster.url, 'Auto', 'Aphrodite — Auto');
        }
      }
    }

    // 4K first (Stremio renders cards top-down)
    streams.sort((a, b) => {
      const rank = (q) => { const m = /(\d{3,4})/.exec(String(q)); return m ? parseInt(m[1], 10) : 0; };
      return rank(b.quality) - rank(a.quality);
    });
    console.log(`[Atlantic] getStreams done: ${streams.length} cards in ${Date.now() - t0}ms (deadline ${DEADLINE_MS}ms)`);
    return streams;
  } catch (e) {
    console.error('[Atlantic]', e?.message || e);
    return [];
  }
}

module.exports = { getStreams, gateReset };
