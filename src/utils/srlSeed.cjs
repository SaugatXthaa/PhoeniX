// src/utils/srlSeed.cjs — shared seed store for api.speedracelight.com consumers
//
// WHY THIS EXISTS (Task 40): the API ROTATES seeds on every /seed request.
// Two consumers fetching /seed?mediaId=<same id> in parallel (e.g. the VidKing
// extractor via speedracelight.js and the cineby source both starting in
// StreamResolver wave-1 for the same media) invalidate each other's seed
// mid-flight → "decrypt failed: bad seed" / HTTP 401 → each side refetches →
// invalidates the other again → retry cascades that blow the 30s wrapper race
// (reproduced on production TV: cineby Frieren 0 @30s while isolated runs
// delivered in ~7s).
//
// This module is a tiny process-wide store: a 25s TTL cache (server seed TTL
// is ~30s) plus an in-flight promise registry so concurrent /seed fetches for
// the SAME mediaId coalesce into ONE upstream request. Consumers keep their
// own fetch implementations (repo Fetcher vs global fetch) — only the store
// is shared.
//
// CJS on purpose: both ESM modules (speedracelight.js) and CJS providers
// (src/nuvio/cineby.cjs via createRequire) must be able to load it.

'use strict';

const SEED_TTL = 25_000;

const cache = new Map();   // key: String(tmdbId) → { seed, ts }
const inflight = new Map(); // key: String(tmdbId) → Promise<string>

function getCached(key) {
  const hit = cache.get(String(key));
  if (hit && Date.now() - hit.ts < SEED_TTL) return hit.seed;
  if (hit) cache.delete(String(key));
  return null;
}

function storeSeed(key, seed) {
  cache.set(String(key), { seed, ts: Date.now() });
}

function invalidateSeed(key) {
  cache.delete(String(key));
}

function getInFlight(key) {
  return inflight.get(String(key)) || null;
}

function setInFlight(key, promise) {
  inflight.set(String(key), promise);
}

function clearInFlight(key) {
  inflight.delete(String(key));
}

// ─── Task 73: upstream-down fast-fail (scoped, self-recovering) ───
//
// When the speedracelight API itself is down (Cloudflare 5xx edge class —
// measured CONSTANT 10/10 probes across 2.5min during the Sep 2026 vidking
// outage, while www.vidking.net's authoritative NS refused globally), the
// per-source empty-retry ladders (Cineby/VidEasy: initial + 2 retries each)
// burn 7-11s of a wave-0 slot per request for guaranteed-zero results — on
// the 0.1-CPU free tier that slot time directly subtracts from healthy
// deliverers in the 40s cold window. A DEFINITIVE edge status (>=500) on a
// fresh /seed probe marks the API down for 120s: both consumers then skip
// their ladders instantly. Timeouts / network errors / honest empties from a
// live seed NEVER mark down (Task 70's failures-never-cached invariant is
// untouched — this caches only a confirmed edge answer, and it self-heals
// within 2 minutes of upstream recovery via TTL expiry).
const SRL_DOWN_TTL_MS = 120_000;
let srlDownUntil = 0;

function isSrlDown() {
  return Date.now() < srlDownUntil;
}

function markSrlDown() {
  srlDownUntil = Date.now() + SRL_DOWN_TTL_MS;
}

// One cheap probe — definitive 5xx from the edge proves the API is down for
// everyone (not a per-IP block, not a flaky server, not an empty window).
async function probeSeedDown(mediaId) {
  try {
    const r = await fetch(`https://api.speedracelight.com/seed?mediaId=${mediaId}`, {
      headers: {
        'Origin': 'https://www.vidking.net',
        'Referer': 'https://www.vidking.net/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(6000),
    });
    return r.status >= 500;
  } catch {
    return false; // network error ≠ proven down — never mark
  }
}

module.exports = {
  SEED_TTL,
  getCached,
  storeSeed,
  invalidateSeed,
  getInFlight,
  setInFlight,
  clearInFlight,
  isSrlDown,
  markSrlDown,
  probeSeedDown,
};
