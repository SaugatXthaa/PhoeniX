// src/utils/EgressWatch.js
//
// Task 89 — EGRESS WATCH: a periodic background prober that makes upstream-side
// recoveries OBSERVABLE instead of silently waiting for someone to run a probe.
//
// WHY (Tasks 86-88 chain): several source zeros are upstream-side gates on
// Render's egress, not code bugs — kmmovies (CF gate at the magiclinks resolve
// step), the acer backend cache-fill outage (fromCache:false for every title,
// all visitors). Task 88 confirmed these heal on THEIR schedule (hindmoviez and
// animezey both self-healed while the IP never rotated). Until now the only way
// to notice was a manual /debug/source round. This watch runs that round
// automatically, tracks the Render egress IP itself, and reports through
// /debug/egresswatch + a compact /health summary.
//
// BONUS (acer only): the watch probe goes through the source's own
// handleInternal — when acer's backend heals, the probe's resolve FILLS the
// 24h positive fallback cache (Task 87), so the first real user open gets
// instant cards instead of a cold resolve.
//
// HARD SAFETY RULES (cacheKeeper discipline — must never degrade a request):
//   1. ADDITIVE ONLY — touches nothing on user paths; probes go through each
//      source's PUBLIC handleInternal, i.e. the exact circuits users hit
//      (acer: cooldown→relay fallback, negative cache, canary short-circuit).
//      No extractor/card/subtitle work.
//   2. GENTLE CADENCE — defaults: IP every 30min, kmmovies every 90min,
//      acer every 180min. Deliberately far under acer's request-count rate
//      limiter (Task 83/87: tiny threshold on Render's range; the watch costs
//      3-6 POSTs per 3h vs the old 9-POST-per-request ladder that tripped
//      24h IP bans). Floors below still allow E2E testing via EGRESS_WATCH_TEST.
//   3. NON-OVERLAPPING — a tick is skipped if the previous one is still
//      running (running flag, like cacheKeeper).
//   4. BOUNDED TELEMETRY — max 40 cycle entries + 10 IP-change events in
//      memory; exposed read-only via /debug/egresswatch and /health.
//   5. OFF-SWITCH — EGRESS_WATCH=off disables everything (tick never starts).
//      EGRESS_WATCH_TEST=1 → fast cadences for sandbox E2E only.
//   6. NO BOOT RACE — first tick is 90s after start (Task 54 decision:
//      nothing races the boot window).
//
// Probe canaries (continuity with Tasks 83/87/88 measurements):
//   kmmovies   → movie tmdb:27205 (Inception) — post matching works, the
//                magiclinks CF gate decides; count>0 means the gate lifted.
//   acermovies → movie tmdb:693134 (Dune: Part Two) — search+quality work,
//                sourceUrl fromCache decides; count>0 means the backend healed
//                (and fills the fallback cache as a side effect).

const IP_MS = Math.max(15_000, parseInt(process.env.EGRESS_WATCH_IP_MS, 10) || 30 * 60_000);
const KM_MS = Math.max(30_000, parseInt(process.env.EGRESS_WATCH_KM_MS, 10) || 90 * 60_000);
const ACER_MS = Math.max(60_000, parseInt(process.env.EGRESS_WATCH_ACER_MS, 10) || 180 * 60_000);
const FIRST_DELAY_MS = Math.max(5_000, parseInt(process.env.EGRESS_WATCH_FIRST_MS, 10) || 90_000);
const TEST_MODE = process.env.EGRESS_WATCH_TEST === '1';
const MEMORY_CEILING_MB = 440; // cacheKeeper parity: skip while tight on memory

const KM_CANARY = 'tmdb:27205';  // Inception
const ACER_CANARY = 'tmdb:693134'; // Dune: Part Two
const KM_TIMEOUT_MS = 50_000;    // km's own internal race is 45s
const ACER_TIMEOUT_MS = 40_000;  // debug-route parity (35s ladder + slack)
const MAX_CYCLES = 40;
const MAX_IP_CHANGES = 10;

const state = {
  started: false,
  enabled: process.env.EGRESS_WATCH !== 'off',
  startedAt: 0,
  lastTickAt: 0,
  running: false,
  timer: null,
  sources: { km: null, acer: null },
  parseId: null,
  lastKmAt: 0,
  lastAcerAt: 0,
  ip: { current: null, since: 0, changes: [] },
  cycles: [],
  stats: { ticks: 0, skippedBusy: 0, skippedMemory: 0, ipChecks: 0, ipErrors: 0, kmProbes: 0, acerProbes: 0, errors: 0 },
};

function cadence() {
  if (!TEST_MODE) return { ip: IP_MS, km: KM_MS, acer: ACER_MS, first: FIRST_DELAY_MS };
  return { ip: 15_000, km: 30_000, acer: 60_000, first: 3_000 };
}

function log(...a) { console.log('[egresswatch]', ...a); }

async function checkIp(entry) {
  state.stats.ipChecks++;
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10_000) });
    const j = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (!j.ip) { state.stats.ipErrors++; entry.ip = { error: 'no ip in response', ms }; return; }
    const changed = state.ip.current !== null && state.ip.current !== j.ip;
    if (state.ip.current === null) { state.ip.current = j.ip; state.ip.since = Date.now(); }
    else if (changed) {
      state.ip.changes.push({ from: state.ip.current, to: j.ip, at: new Date().toISOString() });
      if (state.ip.changes.length > MAX_IP_CHANGES) state.ip.changes.shift();
      state.ip.current = j.ip;
      state.ip.since = Date.now();
      log(`*** EGRESS IP ROTATED → ${j.ip} — egress-class sources (kmmovies etc.) are re-probe candidates ***`);
    }
    entry.ip = { ip: j.ip, changed, ms };
  } catch (e) {
    state.stats.ipErrors++;
    entry.ip = { error: e?.message || String(e), ms: Date.now() - t0 };
  }
}

// Race a source probe with a hard timeout; never throws.
async function probeWithTimeout(source, ctx, type, rawId, timeoutMs) {
  let parsed;
  try { parsed = state.parseId(type, rawId); } catch (e) { return { verdict: `parse-error:${e.message}`, ms: 0, n: 0 }; }
  const t0 = Date.now();
  try {
    const results = await Promise.race([
      source.handleInternal(ctx, type, parsed),
      new Promise(r => setTimeout(() => r({ __timeout: true }), timeoutMs)),
    ]);
    const ms = Date.now() - t0;
    if (results?.__timeout) return { verdict: 'timeout', ms, n: 0 };
    const n = Array.isArray(results) ? results.length : 0;
    return { verdict: n > 0 ? `delivering:${n}` : 'empty', ms, n };
  } catch (e) {
    return { verdict: `error:${(e?.message || String(e)).slice(0, 80)}`, ms: Date.now() - t0, n: 0 };
  }
}

// Acer probe with log capture (same technique as the /debug/source route) so
// the verdict distinguishes backend-broken from ban-cooldown from negative-cache.
async function probeAcer(ctx) {
  const captured = [];
  const orig = console.log;
  console.log = (...a) => {
    const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    if (s.includes('[acermovies]') && captured.length < 30) captured.push(s.slice(0, 200));
    orig(...a);
  };
  try {
    const r = await probeWithTimeout(state.sources.acer, ctx, 'movie', ACER_CANARY, ACER_TIMEOUT_MS);
    const joined = captured.join(' | ');
    if (r.n > 0) {
      r.verdict = `HEALED:${r.n}`;
      log(`*** ACER BACKEND RECOVERED — probe resolved ${r.n} cards; 24h fallback cache now filled ***`);
    } else if (r.verdict === 'empty') {
      if (/429 rate-limited/.test(joined)) r.verdict = '429-cooldown(ban-class)';
      else if (/negative cache fresh/.test(joined)) r.verdict = 'negative-cached(no upstream call)';
      else if (/definitive miss/.test(joined)) r.verdict = 'backend-cache-empty';
      else if (/relay/.test(joined)) r.verdict = 'relay-path-empty';
    }
    r.logTail = joined.slice(-260);
    return r;
  } finally {
    console.log = orig;
  }
}

async function tick() {
  if (!state.enabled) return;
  if (state.running) { state.stats.skippedBusy++; return; }
  // cacheKeeper-parity memory gate: never add work while the box is tight.
  const rssMB = process.memoryUsage().rss / 1024 / 1024;
  if (rssMB > MEMORY_CEILING_MB) { state.stats.skippedMemory++; return; }

  state.running = true;
  const cad = cadence();
  const now = Date.now();
  const entry = { at: new Date().toISOString() };
  try {
    // IP check runs every tick (cheap, no third-party quota).
    await checkIp(entry);

    if (state.sources.km && now - state.lastKmAt >= cad.km) {
      state.lastKmAt = now;
      state.stats.kmProbes++;
      entry.km = await probeWithTimeout(state.sources.km, makeCtx(), 'movie', KM_CANARY, KM_TIMEOUT_MS);
      log(`kmmovies probe: ${entry.km.verdict} @${entry.km.ms}ms`);
    }

    if (state.sources.acer && now - state.lastAcerAt >= cad.acer) {
      state.lastAcerAt = now;
      state.stats.acerProbes++;
      entry.acer = await probeAcer(makeCtx());
      log(`acermovies probe: ${entry.acer.verdict} @${entry.acer.ms}ms`);
    }

    state.cycles.push(entry);
    if (state.cycles.length > MAX_CYCLES) state.cycles.shift();
    state.lastTickAt = Date.now();
  } catch (e) {
    state.stats.errors++;
    log('tick error:', e?.message || e);
  } finally {
    state.running = false;
    state.stats.ticks++;
  }
}

function makeCtx() {
  return {
    hostUrl: new URL('http://egresswatch.local/'),
    id: 'egresswatch',
    ip: '',
    config: { multi: 'on', en: 'on' },
  };
}

export function startEgressWatch({ sources, parseId, logger } = {}) {
  if (state.started || !state.enabled) return;
  if (typeof parseId !== 'function') { log('disabled — no parseId provided'); return; }
  state.started = true;
  state.startedAt = Date.now();
  state.parseId = parseId;
  state.sources.km = sources?.find?.(s => s.id === 'kmmovies') || null;
  state.sources.acer = sources?.find?.(s => s.id === 'acermovies') || null;
  const cad = cadence();
  log(`started (test=${TEST_MODE}) — ip every ${cad.ip / 1000}s, kmmovies every ${cad.km / 1000}s${state.sources.km ? '' : ' (source absent)'}, acermovies every ${cad.acer / 1000}s${state.sources.acer ? '' : ' (source absent)'}, first tick in ${cad.first / 1000}s`);
  state.timer = setTimeout(() => {
    tick();
    state.timer = setInterval(tick, cad.ip);
  }, cad.first);
  if (state.timer.unref) state.timer.unref(); // never hold the process open
}

export function getEgressWatchSummary() {
  if (!state.enabled) return { enabled: false };
  const lastKm = [...state.cycles].reverse().find(c => c.km)?.km || null;
  const lastAcer = [...state.cycles].reverse().find(c => c.acer)?.acer || null;
  return {
    enabled: true, test: TEST_MODE, startedAt: state.started ? new Date(state.startedAt).toISOString() : null,
    ticks: state.stats.ticks, ip: state.ip.current,
    ipSince: state.ip.since ? new Date(state.ip.since).toISOString() : null,
    ipChanges: state.ip.changes.length,
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
    kmmovies: lastKm ? { verdict: lastKm.verdict, ms: lastKm.ms } : null,
    acermovies: lastAcer ? { verdict: lastAcer.verdict, ms: lastAcer.ms } : null,
  };
}

export function getEgressWatchInfo() {
  return {
    enabled: state.enabled, started: state.started, test: TEST_MODE,
    cadence: cadence(), canaries: { kmmovies: KM_CANARY, acermovies: ACER_CANARY },
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
    running: state.running,
    ip: { current: state.ip.current, since: state.ip.since ? new Date(state.ip.since).toISOString() : null, changes: state.ip.changes },
    stats: state.stats,
    cycles: state.cycles,
  };
}
