// src/utils/seekGate.cjs
// ─── Server-side SEEK verdicts for google-family direct targets ─────────────
//
// WHY (Task 96): the user asked for hubcloud cards that seek like the
// 4khdhub/hdhub4u addons. Measured classes after the Task 95 seek audit:
//   - pixeldrain bare / R2 signed / FSL → 206 + Content-Range natively
//     (TRUE seek, already shipped direct);
//   - workers.dev token workers → device-direct (Task 49 semantics), CDN
//     honors Range when the token is valid (206 in Task 92 flap windows);
//   - video-downloads.googleusercontent.com (hubcloud drive finals) → the
//     ONLY linear class. Re-measured 2026-09 (Task 96 probe, capped 1KB):
//     ignores the Range header AND google's own &range= param (200 + full
//     18.8GB body every time). Server-side Range translation is impossible
//     from Render (google hard-stalls datacenter bodies, Task 62), so these
//     cards ship as /range-proxy 302-to-direct → the player sees 200-linear
//     → no seek.
//
// WHAT THIS GATE DOES: google's Range behavior is per-host/product and it
// HAS changed in the past (drive.usercontent.google.com answers 206 today
// where older hosts never did). So probe each google target ONCE per TTL
// with a 1KB-capped Range GET and remember the answer:
//   206 (+ Content-Range) → 'seekable' → StreamResolver rewrites the card
//       to the DIRECT url + requestHeaders (Task 49 pattern) → the player's
//       residential IP gets google's native 206 → TRUE fast seek.
//   anything else         → 'linear'   → card keeps today's /range-proxy 302
//       (plays linearly — the historic working behavior).
//
// TOKEN-SAFETY: the Task 54 note feared google signed links are one-time
// (a probe would consume the token). Disproven by the CURRENT 302 design
// itself: on every player open/seek the player re-fetches the same google
// URL — playback works — and the Task 96 probe did 3 sequential GETs on one
// token with full responses each time. One 1KB GET per TTL is safe.
//
// HARD SAFETY RULES (streamGate discipline):
//   1. NEVER BLOCKS RESOLUTION — kicks are fire-and-forget; the card loop
//      consults the verdict cache synchronously; no verdict yet → card ships
//      exactly as today (302). Verdicts only ever UPGRADE a card, never drop
//      or delay one.
//   2. 1KB-CAPPED READS (Task 95 OOM lesson) — the probe cancels the body
//      after 1KB; an upstream that ignores Range can never stream GBs in.
//   3. BOUNDED CONCURRENCY — max 6 probes in flight; per-URL single-flight.
//   4. SELF-HEALING TTLs — 'linear' verdicts expire fast (30min) so a google
//      behavior change is picked up; 'seekable' lives 6h (google tokens are
//      long-lived; a stale seekable verdict degrades to 200-linear, which is
//      today's behavior anyway — never to breakage).

'use strict';

const GO_FAMILY_RE = /(^|\.)googleusercontent\.com$|(^|\.)google\.com$/i;
const PROBE_TIMEOUT_MS = 5000;
const MAX_CONCURRENT = 12;
const TTL_SEEKABLE_MS = 6 * 60 * 60 * 1000;
const TTL_LINEAR_MS = 30 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const verdicts = new Map(); // inner url -> { state: 'seekable'|'linear', at }
const inFlight = new Set();   // target urls being probed (single-flight)
const promises = new Set();   // in-flight probe promises (pendingSettled)
let inFlightCount = 0;

function log(...a) { console.log('[seekgate]', ...a); }

// Unwrap a card URL to the google target behind it (null when not google).
function googleTargetOf(href) {
  try {
    const u = new URL(href);
    let inner = null;
    if (u.pathname === '/range-proxy' || u.pathname === '/proxy') {
      inner = u.searchParams.get('url');
    }
    const target = inner || (u.hostname === 'egresswatch.local' ? null : href);
    if (!target) return null;
    const t = new URL(target);
    if (GO_FAMILY_RE.test(t.hostname)) return t.href;
    return null;
  } catch (e) {
    return null;
  }
}

function freshVerdict(href) {
  const v = verdicts.get(href);
  if (!v) return null;
  const ttl = v.state === 'seekable' ? TTL_SEEKABLE_MS : TTL_LINEAR_MS;
  if (Date.now() - v.at > ttl) { verdicts.delete(href); return null; }
  return v.state;
}

// 1KB-capped Range probe. Resolves 'seekable' | 'linear' — never throws.
async function probe(targetHref) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(targetHref, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Range': 'bytes=0-1023' },
      signal: ac.signal,
      redirect: 'follow',
    });
    // Cancel the body after at most 1KB — a Range-ignoring host must never
    // stream a full file into the probe (Task 95 OOM lesson).
    let consumed = 0;
    if (r.body) {
      const reader = r.body.getReader();
      try {
        while (consumed < 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          consumed += value.length;
        }
      } catch {}
      // reader.cancel() also cancels the underlying stream; calling
      // r.body.cancel() here would reject (stream locked) as an UNHANDLED
      // promise rejection — sync try/catch cannot catch it (crashed E2E).
      try { await reader.cancel(); } catch {}
    }
    const cr = r.headers.get('content-range');
    const seekable = r.status === 206 && !!cr;
    log(`${seekable ? 'SEEKABLE' : 'linear'} ${r.status} ${new URL(targetHref).hostname} cr=${cr || '-'} (${consumed}B)`);
    return seekable ? 'seekable' : 'linear';
  } catch (e) {
    log(`linear (probe error: ${(e?.message || String(e)).slice(0, 60)}) ${new URL(targetHref).hostname}`);
    return 'linear';
  } finally {
    clearTimeout(timer);
  }
}

// Fire-and-forget: probe the google target behind cardHref if needed.
function kick(cardHref) {
  const target = googleTargetOf(cardHref);
  if (!target) return;
  if (freshVerdict(target)) return;          // fresh verdict — nothing to do
  if (inFlight.has(target)) return;          // single-flight per URL
  if (inFlightCount >= MAX_CONCURRENT) return; // bounded concurrency
  inFlight.add(target);
  inFlightCount++;
  const p = probe(target)
    .then(state => { verdicts.set(target, { state, at: Date.now() }); })
    .catch(() => {})
    .finally(() => { inFlight.delete(target); inFlightCount--; promises.delete(p); });
  promises.add(p);
}

// streamGate parity — lets the resolver's bounded settle-wait include seek
// probes so a cold resolve can ship upgraded cards in the SAME response.
function pendingCount() { return inFlightCount; }
function pendingSettled() { return Promise.allSettled([...promises]); }

// Synchronous consult for the card-build loop: 'seekable' | 'linear' | null.
function verdictSync(cardHref) {
  const target = googleTargetOf(cardHref);
  if (!target) return null;
  return freshVerdict(target);
}

// Test/diagnostic hook.
function _debug() {
  return {
    size: verdicts.size,
    inFlight: inFlightCount,
    entries: [...verdicts.entries()].map(([url, v]) => ({
      host: (() => { try { return new URL(url).hostname; } catch { return '?'; } })(),
      state: v.state,
      ageMin: Math.round((Date.now() - v.at) / 60000),
    })),
  };
}

// Test hook (underscore-prefixed, unused in prod paths): force a verdict so
// E2E can exercise the card-upgrade path on hosts that answer 200 today.
function _setVerdict(cardHref, state) {
  const target = googleTargetOf(cardHref);
  if (target) verdicts.set(target, { state, at: Date.now() });
}

module.exports = { googleTargetOf, kick, verdictSync, pendingCount, pendingSettled, _debug, _setVerdict };
