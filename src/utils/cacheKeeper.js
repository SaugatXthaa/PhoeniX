// src/utils/cacheKeeper.js
//
// Task 74 — IDLE CACHE KEEPER: makes "UptimeRobot keeps the instance awake"
// actually mean "users always open warm streams".
//
// THE PROBLEM (user report, Sep 2026): the user keeps the Render free service
// awake 24/7 with UptimeRobot pinging `/`, yet still sees cold-lottery first
// opens (few streams until refresh 2-5). Measured mechanism: UptimeRobot only
// keeps the PROCESS alive — the per-source stream caches (Source.handle,
// 15min TTL for non-empty results) expire regardless, and a `/` ping never
// warms them. Every open >15 min after the previous one is a full-cold round,
// and on the 0.1-CPU free tier cold rounds are a completion lottery at the
// 40s budget (Task 73). Spinning the instance down and up again has the same
// effect — the keep-alive removes the BOOT penalty but not the CACHE penalty.
//
// THE FIX: while the instance is IDLE, re-resolve the most recently requested
// titles through the EXACT resolver path (Source.handle → sourceResultCache),
// so the caches a real user request consults never go stale. After one warm
// pass, re-opening the title at ANY later time gets the converged warm-round
// card set on round 1.
//
// HARD SAFETY RULES (this module must never degrade a user request):
//   1. USER TITLES ONLY — it warms titles a real request actually opened
//      (LRU, max 5). No fixed catalog, no speculative scraping.
//   2. IDLE-GATED — a pass starts only after CACHE_KEEPER_IDLE_MS (3 min
//      default) with zero user /stream activity.
//   3. YIELDING — before every individual source start inside a pass, the
//      idle check re-runs: the moment a user request lands, no NEW keeper
//      sources start (in-flight ones finish; Source.handle's inflight-dedupe
//      shares work with the user's own resolve instead of duplicating it).
//   4. SAME PATH ONLY — it calls source.handle(), the same entry the resolver
//      uses: same single-flight, same caches, same failure contract
//      (Task 70: errors are never cached). No extractor/card/subs work —
//      that stage is per-request anyway; the expensive scrapes are what get
//      cached.
//   5. MEMORY-GATED — passes are skipped while RSS > 440MB (512MB free tier).
//   6. EXACT SCHEDULING PARITY — source selection/order comes from the
//      resolver's own exported orderSourcesForRequest() (same wave priority,
//      same movie anime-skip), so warmed caches == what a warm round uses.
//   7. Off-switch: CACHE_KEEPER=off disables everything (tick loop never
//      starts). The Task 54 "no boot-time prewarm" decision stands: nothing
//      here runs at boot or races boot-window requests — the first tick is
//      CACHE_KEEPER_IDLE_MS after the last user activity, never before.
//
// Telemetry: /health exposes cacheKeeper stats so the production effect is
// verifiable from outside (passes, warmed counts, yields, skips).
import { orderSourcesForRequest } from './StreamResolver.js';

const IDLE_MS = Math.max(30_000, parseInt(process.env.CACHE_KEEPER_IDLE_MS, 10) || 180_000);
const TICK_MS = Math.max(15_000, parseInt(process.env.CACHE_KEEPER_TICK_MS, 10) || 60_000);
const CONCURRENCY = Math.max(1, parseInt(process.env.CACHE_KEEPER_CONCURRENCY, 10) || 3);
const SOURCE_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.CACHE_KEEPER_SOURCE_TIMEOUT_MS, 10) || 20_000);
const MAX_KEYS = 5;
const MEMORY_CEILING_MB = Math.max(300, parseInt(process.env.CACHE_KEEPER_MEMORY_CEILING_MB, 10) || 440);
// A pass stops starting new sources when the user came back this recently.
const YIELD_WINDOW_MS = 30_000;

const state = {
  started: false,
  enabled: process.env.CACHE_KEEPER !== 'off',
  hotKeys: new Map(), // key → { type, rawId, lastAt, lastWarmedAt, warmCount }
  lastUserActivityAt: 0,
  running: false,
  stats: {
    passes: 0, lastPassAt: 0, lastPassMs: 0, lastPassKey: '',
    lastPassWarmed: 0, lastPassResults: 0, lastPassYielded: false,
    lastPassErrors: 0, skippedBusy: 0, skippedActive: 0, skippedMemory: 0,
    startedAt: 0,
  },
};

export function recordUserRequest(type, rawId) {
  if (!state.enabled) return;
  state.lastUserActivityAt = Date.now();
  const key = `${type}:${rawId}`;
  const prev = state.hotKeys.get(key);
  if (prev) {
    prev.lastAt = Date.now();
    state.hotKeys.delete(key);
    state.hotKeys.set(key, prev); // LRU refresh
  } else {
    state.hotKeys.set(key, { type, rawId, lastAt: Date.now(), lastWarmedAt: 0, warmCount: 0 });
    if (state.hotKeys.size > MAX_KEYS) {
      // evict least-recently-requested
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, v] of state.hotKeys) {
        if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k; }
      }
      if (oldestKey) state.hotKeys.delete(oldestKey);
    }
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`keeper: ${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function rssMb() {
  try { return process.memoryUsage().rss / 1048576; } catch { return 0; }
}

async function runPass(entry, { sources, parseId, logger, hostUrl }) {
  const t0 = Date.now();
  let parsedId = null;
  try {
    parsedId = parseId(entry.type, entry.rawId);
  } catch { parsedId = null; }
  if (!parsedId) return;

  const ctx = {
    hostUrl: new URL(hostUrl),
    id: 'cache-keeper',
    ip: '127.0.0.1',
    config: { multi: 'on', en: 'on' },
  };
  const scheduled = orderSourcesForRequestSafe(sources, entry.type);

  let warmed = 0, results = 0, errors = 0, yielded = false;
  let idx = 0;
  const worker = async () => {
    while (true) {
      const my = idx++;
      if (my >= scheduled.length) return;
      if (Date.now() - state.lastUserActivityAt < YIELD_WINDOW_MS) {
        yielded = true;
        return; // stop starting new keeper sources — the user is back
      }
      const source = scheduled[my];
      try {
        const r = await withTimeout(source.handle(ctx, entry.type, parsedId), SOURCE_TIMEOUT_MS, source.id);
        warmed++;
        results += Array.isArray(r) ? r.length : 0;
      } catch {
        errors++; // Task 70 contract: errors are uncached — nothing poisoned
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scheduled.length) }, worker));

  entry.lastWarmedAt = Date.now();
  entry.warmCount++;
  const s = state.stats;
  s.passes++; s.lastPassAt = Date.now(); s.lastPassMs = Date.now() - t0;
  s.lastPassKey = `${entry.type}:${entry.rawId}`;
  s.lastPassWarmed = warmed; s.lastPassResults = results;
  s.lastPassYielded = yielded; s.lastPassErrors = errors;
  logger.log(`[cache-keeper] pass ${entry.type} ${entry.rawId}: ${warmed} sources warmed, ${results} cached results, ${errors} errors, ${s.lastPassMs}ms${yielded ? ' (yielded to user)' : ''}`);
}

// Same scheduling source of truth as the resolver (exact wave order + movie
// anime-skip). StreamResolver does not import this module — no cycle.
function orderSourcesForRequestSafe(sources, type) {
  try { return orderSourcesForRequest(sources, type); }
  catch { return sources.slice(); }
}

export function startCacheKeeper({ sources = [], parseId, logger, hostUrl }) {
  if (!state.enabled) {
    logger.log('[cache-keeper] disabled (CACHE_KEEPER=off)');
    return;
  }
  if (state.started) return;
  if (typeof parseId !== 'function') {
    logger.log('[cache-keeper] not started: parseId callback missing');
    return;
  }
  state.started = true;
  state.stats.startedAt = Date.now();
  logger.log(`[cache-keeper] armed: idle>${IDLE_MS / 1000}s, tick ${TICK_MS / 1000}s, concurrency ${CONCURRENCY}, per-source cap ${SOURCE_TIMEOUT_MS / 1000}s, rss ceiling ${MEMORY_CEILING_MB}MB`);
  const timer = setInterval(() => {
    const s = state.stats;
    if (state.running) { s.skippedBusy++; return; }
    if (state.hotKeys.size === 0) return;
    if (Date.now() - state.lastUserActivityAt < IDLE_MS) { s.skippedActive++; return; }
    if (rssMb() > MEMORY_CEILING_MB) { s.skippedMemory++; return; }
    // Oldest-warmed first; never-warmed (0) wins so a fresh hot key gets its
    // first pass immediately. Ties break toward the most recently requested.
    let entry = null;
    for (const v of state.hotKeys.values()) {
      if (!entry || (v.lastWarmedAt || 0) < (entry.lastWarmedAt || 0) ||
          ((v.lastWarmedAt || 0) === (entry.lastWarmedAt || 0) && v.lastAt > entry.lastAt)) {
        entry = v;
      }
    }
    if (!entry) return;
    state.running = true;
    runPass(entry, { sources, parseId, logger, hostUrl })
      .catch(() => {})
      .finally(() => { state.running = false; });
  }, TICK_MS);
  if (timer.unref) timer.unref(); // never keep the process alive for the keeper
}

export function getCacheKeeperInfo() {
  return {
    enabled: state.enabled,
    running: state.running,
    idleMs: IDLE_MS,
    hotKeys: [...state.hotKeys.values()].map(v => ({
      key: `${v.type}:${v.rawId}`, lastAt: v.lastAt, lastWarmedAt: v.lastWarmedAt, warmCount: v.warmCount,
    })),
    stats: { ...state.stats },
  };
}
