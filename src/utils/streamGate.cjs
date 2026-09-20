// src/utils/streamGate.cjs
// ─── Server-side liveness verdicts for flaky direct-card hosts ──────────────
//
// WHY (Task 42 sweep evidence — every final card on Inception / BreakingBad
// S1E1 / Frieren S1E1 probed with magic-byte + playlist-tree checks):
//   1. pixeldrain.com|dev /api/file/<id> hosts ANY file type. Status-only
//      liveness checks (Task 39/41 headOk / pdAliveCached) pass 200/206 ZIP
//      season-packs (sweep caught "Movies4u.Foo.Frieren...S01E01-14...zip",
//      4.97GB, application/zip, filename says 1080p!) → shipped as "streams"
//      → player error / stuck loading. 8 such dead cards measured on
//      BreakingBad S1E1 alone.
//   2. vimeos.(zip|net) HLS fronts (speedracelight Omen/lamovie servers and
//      framextv providers) flipped to unconditional 403 text/html for
//      datacenter ranges (Task 40 verified 200-#EXTM3U no-referer from the
//      same sandbox; 2026-09-17 sweep: 403 text/html with/without Referer,
//      with/without browser header set, fresh tokens included) → the card
//      IS an HTML error page — the exact "html url" class the user reports.
//   3. fetch.nexabloom.top (itachi/anikoto/anidoor/animeflix/raflix/
//      nikastream/anikototv/streamxtv anime cards): Cloudflare 403 HTML,
//      referer-immune (verified with itachi.su / animekoto / strem referers),
//      cf-ray present. 15+ dead anime cards in one sweep.
//   4. nhdapi.com/anime/<id>/<ep> (raflix): returns 200 text/html — an API
//      HTML PAGE shipped as a stream URL. Never a media stream.
//   5. moon|sun.peakstorm.top + playeng.animeapps.top + scraper.vidbolt.xyz
//      (the vidking/speedracelight family behind cinewave/videasy/cineby/
//      videasyto/vidsrcsbs/watchseries/vidking/streamxtv/anibd): these trees
//      DIE TRANSIENTLY — 2026-09-16 sweep caught peakstorm r2/cdn1 trees
//      with dead children across 10 sources simultaneously (same backend
//      shared); 2026-09-17 vidbolt master+variant 200 but SEGMENTS return
//      text/html. Trees recover later (peakstorm verified alive again next
//      day), so verdicts must SELF-HEAL, not ban permanently.
//   6. prox.anicore.tv (anikage HLS/MP4 relay, Origin-gated → routed through
//      our /proxy): Task 44 final sweep caught the relay DOWN — 5/5 cards
//      502 simultaneously (5 distinct fresh tokens, same host) while every
//      other source was healthy. Probe fidelity is EXACT here: the card URL
//      the player fetches IS our /proxy, i.e. our own server does the
//      upstream fetch — a 502 to the probe is a 502 to the player. Relay
//      outages are transient (upstream redeploys), so the self-healing
//      verdicts apply: dead phase → drop cards (no stuck-loading), alive
//      phase → ship normally.
//
// HOW (zero budget impact — Task 36 architecture untouched):
//   Probes NEVER block resolution. StreamResolver fires a non-blocking
//   kick() per gated URL as each source settles; the card-build loop
//   consults the verdict cache synchronously:
//       alive   → ship
//       dead    → drop card (no html-url / zip-url / dead-tree cards ship)
//       unknown → ship (status quo — probe pending/inconclusive/network flake)
//   Deep HLS probe follows the playlist tree (master → child → grandchild)
//   exactly as the player would, so "alive master + dead children" trees
//   are caught. Verdicts self-heal via short TTLs.
//   /proxy-wrapped cards are gated on their INNER hostname (the upstream
//   we proxy), but probed at the CARD URL — exactly what the player fetches.
//
// DUAL IMPORT (same pattern as site-secrets.cjs): CJS require + ESM default
// interop both work.

'use strict';

const dns = require('node:dns');

// Verdict cache: positive entries live longer than negative ones (a dead
// file can be re-uploaded under the same ID far less often than a flaky
// host recovers).
const VERDICT_TTL_ALIVE_MS = 10 * 60 * 1000;
const VERDICT_TTL_DEAD_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4000;
const MAX_HLS_FETCHES = 3;      // master + up to 2 playlist levels
const MAX_CONCURRENT = 6;       // probe chains in flight (fire-and-forget CPU guard)

// Gated host families (regex on the effective hostname — INNER host for
// /proxy-wrapped cards):
//   pixeldrain.com|dev  — any-file-type host (zips ship as "streams")
//   vimeos.zip|net      — inverted-referer HLS, now unconditional 403 html
//   peakstorm.top       — vidking/speedracelight family (moon/sun/… rotate)
//   animeapps.top       — anibd/nikastream playeng trees
//   vidbolt.xyz         — vidking family m3u8 proxy (segments went html)
//   nexabloom.top       — CF 403-html anime CDN (itachi/anikoto/…)
//   nhdapi.com          — HTML page shipped as stream URL (raflix)
//   anicore.tv          — anikage relay; whole-host 502 outages (see WHY #6)
//   lh3.googleusercontent.com — Task 54: HDHub4u/AcerMovies extraction
//                       sometimes falls back to a Google Photos THUMBNAIL
//                       (lh3.../pw/... → 200 image/png) shipped as a "stream";
//                       probing + the image-body verdict (below) kills the card.
//   NOTE: video-downloads.googleusercontent.com is deliberately NOT gated —
//   its signed links are ONE-TIME/short-lived; a probe would consume the token
//   and break real playback (Task 54: fresh link 200 video/mkv direct).
const GATED_HOST_RE = /(^|\.)pixeldrain\.(com|dev)$|(^|\.)vimeos\.(zip|net)$|(^|\.)peakstorm\.top$|(^|\.)animeapps\.top$|(^|\.)vidbolt\.xyz$|(^|\.)nexabloom\.top$|(^|\.)nhdapi\.com$|(^|\.)urbansolardiyprojectshub\.site$|(^|\.)anicore\.tv$|(^|\.)lh3\.googleusercontent\.com$/i;
const VIDEO_EXT_RE = /\.(mkv|mp4|webm|avi|ts|m2ts|mov|flv|wmv|mpg|mpeg|m4v)(?:[?#]|$)/i;
const ARCHIVE_EXT_RE = /\.(zip|rar|7z|tar|gz|001)(?:[?#]|$)/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const verdicts = new Map(); // url -> { state: 'alive'|'dead', at }
const inFlight = new Map(); // url -> promise
const hostLocks = new Map(); // inner host -> promise chain (serialize probes per upstream)
// Host-level circuit breaker: when a host racks up consecutive dead verdicts
// (nexabloom: EVERY url 403-html; vidbolt: whole trees dead), stop re-probing
// every new per-URL token — verdict 'dead' instantly. Self-heals after the
// window; a single alive verdict resets the counter.
const circuits = new Map(); // host -> { deaths, lastAt, openUntil }
const CIRCUIT_DEATHS = 3;
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;
let activeProbes = 0;
const waiters = [];

// Effective hostname for gating: /proxy and /range-proxy cards act on their
// INNER url (the upstream we proxy); everything else is its own host.
function gateHostOf(href) {
  try {
    const u = new URL(href);
    if (u.pathname === '/proxy' || u.pathname === '/range-proxy') {
      const inner = u.searchParams.get('url');
      if (inner) return new URL(inner).hostname;
    }
    return u.hostname;
  } catch (e) {
    return '';
  }
}

function isGatedHost(hostname) {
  return GATED_HOST_RE.test(hostname || '');
}

// Concurrency gate so a burst of gated cards cannot stampede upstream/CPU.
async function acquire() {
  if (activeProbes < MAX_CONCURRENT) { activeProbes++; return; }
  await new Promise(resolve => waiters.push(resolve));
  activeProbes++;
}
function release() {
  activeProbes--;
  const w = waiters.shift();
  if (w) w();
}

// Definitive network failures. ENOTFOUND is DNS NXDOMAIN — the NAME does
// not exist (Node reports temporary resolver failures as EAI_AGAIN, not
// ENOTFOUND), so no client-side flake path recovers it. Verified with a
// second OS-resolver lookup before committing to 'dead'. Only used for
// GATED families where the probe IS the player's fetch path (proxied) or
// the host is user-independent (pixeldrain). Everything else — timeouts,
// aborts, EAI_AGAIN, TLS, 5xx — stays 'unknown' (never drop on inconclusive).
function isNxDomainErr(e) {
  return String(e?.cause?.code || e?.code || '').toUpperCase() === 'ENOTFOUND';
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

// Pixeldrain file verdict. HEAD is enough (headers carry every signal);
// falls back to a 2KB ranged GET when HEAD is rejected outright.
//   dead file  → 404 (+ application/json)
//   non-video  → 200/206 + Content-Disposition filename.zip/.rar
//   video      → 200/206 + ct video/x-matroska|video/mp4 (or octet-stream)
//                + Content-Disposition filename.mkv/.mp4
async function probePixeldrain(url) {
  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'HEAD', headers: { 'user-agent': UA } });
  } catch (e) {
    try {
      res = await fetchWithTimeout(url, { headers: { 'user-agent': UA, 'range': 'bytes=0-2047' } });
      try { await res.body.cancel(); } catch (_) { /* already consumed or errored */ }
    } catch (e2) {
      if (isNxDomainErr(e2)) {
        // Double-check DNS once: NXDOMAIN confirmed twice (OS resolver) → the
        // host is gone for every user; a one-shot resolver hiccup → 'unknown'.
        try { await dns.promises.lookup(new URL(url).hostname); return 'unknown'; } catch (_) { return 'dead'; }
      }
      return 'unknown'; // network flake — never drop on inconclusive
    }
  }
  if (res.status === 404 || res.status === 410) return 'dead';
  // Task 57: pixeldrain 403 has TWO distinct meanings. (a) The documented
  // datacenter-gate (residential passes — 'unknown'); (b) the FILE-level
  // bandwidth captcha: `{"value":"file_rate_limited_captcha_required"}` —
  // pixeldrain rate-limits hotlink downloads once a free-tier file's rolling
  // bandwidth runs out (verified live: GoT S01E01 6.4GB file, 77GB used in 3
  // days → 403 captcha JSON from EVERY IP, player included). Case (b) is DEAD
  // for users — mpv cannot solve a captcha. Read the 403 body and decide.
  if (res.status === 403) {
    try {
      const bodyRes = await fetchWithTimeout(url, { headers: { 'user-agent': UA, 'range': 'bytes=0-2047' } });
      const body = await bodyRes.text();
      try { await bodyRes.body.cancel(); } catch (_) { /* already consumed or errored */ }
      if (body.includes('file_rate_limited') || body.includes('captcha_required')) return 'dead';
    } catch { /* body fetch failed — inconclusive */ }
    return 'unknown'; // plain 403 without the captcha body → IP-gate class
  }
  if (res.status < 200 || res.status >= 400) return 'unknown';

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const cd = (res.headers.get('content-disposition') || '').toLowerCase();
  const fnMatch = cd.match(/filename\*?=(?:utf-8'')?([^;\s]+)/);
  const filename = fnMatch ? decodeURIComponent(fnMatch[1].replace(/^"|"$/g, '')) : '';

  if (ct.includes('application/json')) return 'dead';
  if (ct.includes('text/html')) return 'dead';
  if (filename && ARCHIVE_EXT_RE.test(filename)) return 'dead';
  if (/\bzip\b|\brar\b|x-7z|x-tar|gzip/.test(ct)) return 'dead';
  if (filename && VIDEO_EXT_RE.test(filename)) return 'alive';
  if (ct.startsWith('video/') || ct.includes('x-matroska')) return 'alive';
  if (ct.includes('octet-stream') && !filename) return 'unknown'; // can't tell — ship
  if (ct.includes('octet-stream') && filename && !ARCHIVE_EXT_RE.test(filename)) return 'alive';
  return 'unknown';
}

// Body-truth media sniff: mirrors in the vidking/peakstorm family lie about
// Content-Type (200 text/html + real MPEG-TS body, 206 image/jpeg + TS body —
// both verified live Task 42). The BODY decides, the header never does.
function isMediaBody(body) {
  const s = body.slice(0, 2048);
  if (s.length === 0) return false;
  if (s.indexOf('\u0000') !== -1) return true;                                 // NUL byte → binary (TS/MKV/MP4)
  if (s.charCodeAt(0) === 0x47 && s.length > 188 && s.charCodeAt(188) === 0x47) return true; // TS sync doublet
  if (s.slice(4, 8) === 'ftyp') return true;                                   // MP4
  if (s.charCodeAt(0) === 0x1a && s.charCodeAt(1) === 0x45 && s.charCodeAt(2) === 0xdf && s.charCodeAt(3) === 0xa3) return true; // MKV EBML
  return false;
}

// One fetch level of an HLS tree, exactly as the player requests it.
//   'dead'  → definitive: 403/410/404 status, or an HTML body (the "html url" class)
//   'm3u8'  → valid playlist, body + first child line returned
//   'media' → binary/video response (segment or direct file)
//   'unknown' → inconclusive (network flake, 5xx, weird body)
async function fetchHlsLevel(url, headers = {}) {
  let res;
  let body = '';
  try {
    res = await fetchWithTimeout(url, { headers: { 'user-agent': UA, ...headers } });
    body = (await res.text()).slice(0, 16384); // playlists are KB-sized
  } catch (e) {
    if (isNxDomainErr(e)) {
      // DNS NXDOMAIN (Task 44: prox.anicore.tv relay outage — every anikage
      // card unresolvable). Confirm with a second OS-resolver lookup so a
      // one-shot resolver hiccup stays 'unknown' while a real NXDOMAIN
      // (host gone for the player too) is definitive death.
      try { await dns.promises.lookup(new URL(url).hostname); return { state: 'unknown' }; } catch (_) { return { state: 'dead', err: 'ENOTFOUND' }; }
    }
    return { state: 'unknown' };
  }
  const status = res.status;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // Task 65: lh3.googleusercontent.com/pw/ (Google Photos class — MoviesHunt
  // abhilinks chains) answers DATACENTER probes with 403 + image/png (the
  // 818B identity pixel) for files that are REAL for the user's device IP —
  // the same hotlink-block class Task 62 routed around with the google-family
  // 302-to-direct in /range-proxy. Verdict 'unknown' keeps the card alive for
  // the player (only 'dead' drops). The Task 54 THUMBNAIL class (200 +
  // image/* body) stays definitively dead below, and hard 404/410 stay dead.
  if (status === 403 && ct.startsWith('image/') && /(^|\.)lh3\.googleusercontent\.com$/i.test(new URL(url).hostname)) {
    return { state: 'unknown', status, ct, note: 'lh3-hotlink-block' };
  }
  if (status === 403 || status === 410 || status === 404) return { state: 'dead', status, ct };
  if (status < 200 || status >= 400) return { state: 'unknown', status, ct };
  const head = body.trimStart().slice(0, 64).toLowerCase();
  // BODY TRUTH first: binary data with a lying text/html ct is MEDIA
  // (quickstorm.top verified shipping exactly that); an html body with a
  // media ct is still an html page. Playlist markers override ct too.
  if (head.startsWith('#extm3u') || head.startsWith('#ext-x')) {
    const child = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))[0];
    if (!child) return { state: 'dead', status, ct, note: 'empty-playlist' };
    let childUrl;
    try { childUrl = new URL(child, res.url || url).href; } catch (e) { return { state: 'unknown', status, ct }; }
    return { state: 'm3u8', childUrl, status, ct };
  }
  if (head.startsWith('<!doctype') || head.startsWith('<html') || (head.includes('<html') && !isMediaBody(body))) {
    return { state: 'dead', status, ct };
  }
  if (isMediaBody(body)) return { state: 'media', status, ct };
  // Task 54: a body that is genuinely an IMAGE (thumbnails shipped as streams —
  // lh3.googleusercontent.com/pw/ Google Photos previews via HDHub4u) can never
  // play. AFTER the isMediaBody check so the Task 42 verified lie class
  // (206 image/jpeg ct over a real TS body) still verdicts 'media'.
  if (ct.startsWith('image/')) return { state: 'dead', status, ct, note: 'image-body' };
  if (ct.includes('text/html')) return { state: 'dead', status, ct }; // html-ish body without literal <html head
  if (ct.includes('application/json')) return { state: 'dead', status, ct };
  if (ct.includes('mpegurl') || ct.includes('vnd.apple')) return { state: 'unknown', status, ct }; // ct says playlist, body unclear (truncated fetch)
  return { state: 'unknown', status, ct };
}

// Gated HLS host verdict (vimeos.*, peakstorm.*, animeapps.*, vidbolt.xyz,
// nexabloom.top, nhdapi.com): walk the tree as the player would, up to 3
// fetches. Catches alive-master-with-dead-children and html-segment trees.
//   alive → every probed level is a valid playlist ending in real media
//   dead  → any level 403/410/404/html/empty (definitive dead signals only)
async function probeHls(url, headers = {}) {
  let current = url;
  for (let i = 0; i < MAX_HLS_FETCHES; i++) {
    const lvl = await fetchHlsLevel(current, headers);
    if (lvl.state === 'dead') return 'dead';
    if (lvl.state === 'unknown') return 'unknown';
    if (lvl.state === 'media') return 'alive';
    // m3u8 → follow first child (next loop iteration)
    current = lvl.childUrl;
  }
  return 'alive'; // 3 playlist levels deep and every level valid — real tree
}

// Unwrap /proxy|/range-proxy cards: probe the INNER upstream exactly as the
// proxy would (url + referer/origin params as headers). Two wins: no self-
// request round-trip through the addon (probe fan-out used to hit our own
// Render URL), and no dependency on the https hostUrl hardcode (locally the
// addon is plain HTTP, so self-probes TLS-failed → verdicts never landed).
function unwrapProxy(href) {
  try {
    const u = new URL(href);
    if (u.pathname === '/proxy' || u.pathname === '/range-proxy') {
      const inner = u.searchParams.get('url');
      if (inner) {
        const headers = {};
        const ref = u.searchParams.get('referer');
        const org = u.searchParams.get('origin');
        if (ref) headers.referer = ref;
        if (org) headers.origin = org;
        return { url: inner, headers, range: u.pathname === '/range-proxy' };
      }
    }
  } catch (e) { /* fallthrough — probe as direct */ }
  return null;
}

async function probe(url) {
  const host = gateHostOf(url);
  // Circuit open → host is conclusively dead recently; skip the fetch queue.
  const circ = circuits.get(host);
  if (circ && circ.openUntil > Date.now()) return 'dead';
  if (activeProbes >= MAX_CONCURRENT) return 'unknown'; // busy — never queue-drop cards on latency
  await acquire();
  try {
    const un = unwrapProxy(url);
    const target = un ? un.url : url;
    const headers = { 'user-agent': UA, ...(un ? un.headers : {}) };
    if (un && un.range) headers.range = 'bytes=0-2047'; // range-proxy cards: ranged GET like the player
    if (/^pixeldrain\.(com|dev)$/i.test(host)) return await record(host, await probePixeldrain(target));
    // Serialize per upstream host: concurrent same-host probes can trip
    // upstream rate-limiters (403 bursts) → false dead verdicts. Chained
    // locks keep at most ONE probe chain in flight per gated host.
    const prev = hostLocks.get(host) || Promise.resolve();
    let releaseLock;
    const myToken = new Promise(r => { releaseLock = r; });
    hostLocks.set(host, prev.then(() => myToken));
    await prev.catch(() => {});
    try {
      // Re-check after the lock wait: probes queued before the circuit opened
      // must not fetch — verdict 'dead' without the upstream round-trip.
      const circ2 = circuits.get(host);
      if (circ2 && circ2.openUntil > Date.now()) return 'dead';
      return await record(host, await probeHls(target, headers));
    } finally {
      releaseLock();
    }
  } catch (e) {
    return 'unknown';
  } finally {
    release();
  }
}

// Feed the host circuit breaker: dead → deaths++, ≥3 in window → open;
// alive → reset.
function record(host, state) {
  if (state === 'unknown') return state;
  const now = Date.now();
  const circ = circuits.get(host) || { deaths: 0, lastAt: 0, openUntil: 0 };
  if (state === 'dead') {
    circ.deaths = (now - circ.lastAt < CIRCUIT_WINDOW_MS) ? circ.deaths + 1 : 1;
    circ.lastAt = now;
    if (circ.deaths >= CIRCUIT_DEATHS) circ.openUntil = now + CIRCUIT_OPEN_MS;
  } else {
    circ.deaths = 0;
    circ.openUntil = 0;
  }
  if (circuits.size > 512) circuits.clear();
  circuits.set(host, circ);
  return state;
}
// Awaitable snapshot of in-flight probes — the resolver gives kicked probes
// a short settle window on cache-hit requests (all sources resolve instantly
// there, so same-tick probes would never land before the build loop).
function pendingCount() { return inFlight.size; }
function pendingSettled() { return Promise.allSettled([...inFlight.values()]); }

// Fire-and-forget probe. Safe to call repeatedly: fresh verdicts short-
// circuit, concurrent probes for the same URL coalesce.
function kick(url) {
  const hit = verdicts.get(url);
  if (hit) {
    const ttl = hit.state === 'alive' ? VERDICT_TTL_ALIVE_MS : VERDICT_TTL_DEAD_MS;
    if (Date.now() - hit.at < ttl) return;
    verdicts.delete(url);
  }
  // Circuit open → synchronous dead verdict, no probe at all (late-resolving
  // sources get dropped in the SAME request that opens the circuit).
  const circ = circuits.get(gateHostOf(url));
  if (circ && circ.openUntil > Date.now()) {
    if (verdicts.size > 2048) verdicts.clear();
    verdicts.set(url, { state: 'dead', at: Date.now() });
    return;
  }
  if (inFlight.has(url)) return;
  const p = probe(url)
    .then(state => {
      inFlight.delete(url);
      if (state === 'unknown') return; // no verdict — leave uncached, retry next kick
      if (verdicts.size > 2048) verdicts.clear();
      verdicts.set(url, { state, at: Date.now() });
    })
    .catch(() => { inFlight.delete(url); });
  inFlight.set(url, p);
}

// Sync consult for the card-build loop: 'alive' | 'dead' | 'unknown'
function verdict(url) {
  const v = verdicts.get(url);
  if (!v) return 'unknown';
  const ttl = v.state === 'alive' ? VERDICT_TTL_ALIVE_MS : VERDICT_TTL_DEAD_MS;
  if (Date.now() - v.at >= ttl) return 'unknown';
  return v.state;
}

// Awaitable boolean for scrapers that pick between mirror candidates:
// true only when the pixeldrain file is a definitively playable VIDEO.
function pdVideoOk(pixeldrainUrl) {
  return probe(pixeldrainUrl).then(s => s === 'alive');
}

module.exports = { isGatedHost, gateHostOf, kick, verdict, probe, pdVideoOk, pendingCount, pendingSettled };
