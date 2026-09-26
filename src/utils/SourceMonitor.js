// src/utils/SourceMonitor.js
//
// Task 98 — REAL-TIME SOURCE STATUS MONITOR.
//
// WHY: the Task 90 /status page is PASSIVE — it only reports what real user
// traffic already produced, so an unrequested source shows "no recent
// requests" forever. The configure UI (same-to-same with the reference
// addon) shows a live up/down dot for EVERY source, and the user explicitly
// demanded "same status for all sources with real time status, not wrong and
// incorrect data". That needs an ACTIVE monitor: a background prober that
// exercises every source on a schedule and records the honest outcome.
//
// HOW (the reference /api/status contract, reimplemented on our machinery):
//   - one source probed at a time (concurrency 1) with a gap between probes,
//     so the whole 67-source sweep takes ~25 min and per-probe load is a
//     single scrape — the same weight as one user opening one title.
//   - each probe calls source.handleInternal() directly (scrape stage only —
//     the same definition the Task 78 per-source audit and the /debug/source
//     route use; extraction is downstream of a successful scrape) with a
//     35s race cap, on a rotating probe title.
//   - probe titles: a movie for movie-capable sources (rotated per sweep for
//     diversity), an anime episode for the anime-only set (rotated too).
//     Series-capable sources get the movie too (they are all movie+series
//     scrapers here). An empty FIRST probe gets ONE second-chance probe with
//     the next title in the rotation before "down" is recorded — per-title
//     catalog gaps must not paint a working source as down.
//   - verdicts: up = scrape returned >=1 result within the cap; down =
//     empty / timeout / error on both attempts. responseTimeMs = scrape
//     duration. lastCheck = ISO timestamp. error = short error string.
//   - a sweep keeps going across "sweep changed" boundaries; the monitor is
//     strictly sequential so it can never stack load.
//
// SAFETY RULES (Task 90 heritage, adapted):
//   - probes run in the BACKGROUND only; they never touch the user request
//     path. Each probe is one scrape — the addon already does dozens per
//     real user resolve.
//   - memory is bounded: one fixed-shape record per source, counters only.
//   - the monitor NEVER writes into the per-source result caches' invalidation
//     machinery — handleInternal is the cache-bypassing stage, identical to
//     /debug/source (Task 38 precedent).
//   - probes yield to playback: the Task 54 playback-priority gate is honored
//     by waiting while a stream is actively serving (checked between probes).
//   - disabled via PHOENIX_SOURCE_MONITOR=0 (off switches are load-bearing in
//     every background subsystem here — EgressWatch/cacheKeeper precedent).

import { ImdbId } from './id.js';
import playbackGate from './playbackGate.cjs';

const PROBE_TIMEOUT_MS = 35_000;   // same per-probe cap as /debug/source (Task 38)
const GAP_BETWEEN_PROBES_MS = 25_000; // one source every ~25s → 67 sources ≈ 28min sweep
const MAX_ERROR_LEN = 160;

// Probe titles (movie) — rotated every sweep for diversity. These are the
// same titles the Task 78 audit used, chosen because nearly every source in
// the registry carries them (mainstream + a regional + a classic).
const MOVIE_PROBES = [
  { raw: 'tt15239678', label: 'Dune 2' },
  { raw: 'tt1375666', label: 'Inception' },
  { raw: 'tt0111161', label: 'Shawshank' },
  { raw: 'tt8178634', label: 'RRR' },
];
// Anime-only sources are episode scrapers (Task 61 resolver truth) — they
// get an anime episode. ROTATED per sweep (same policy as the movie probes):
// a single fixed title painted sources with honest catalog gaps as "down"
// (production-measured: animeflix returns 0 on the JJK probe but delivers
// Frieren — a catalog gap, not an outage). Both ids are delivery-proven:
// 127532 = 17/19 anime-only sources delivered on the Task 98 boot sweep;
// 209867 (Frieren S2E1) = Task 61/78 audit probe.
const ANIME_PROBES = [
  { raw: 'tmdb:127532:1:1', label: 'JJK S1E1', type: 'series', tmdb: 127532 },
  { raw: 'tmdb:209867:2:1', label: 'Frieren S2E1', type: 'series', tmdb: 209867 },
];

const state = new Map(); // sourceId -> record
let monitorTimer = null;
let started = false;
let sweepCount = 0;
let lastSweepStartedAt = null;
let lastSweepFinishedAt = null;

function record(id, name) {
  let r = state.get(id);
  if (!r) {
    r = {
      id,
      name,
      status: null,            // 'up' | 'down' | null (not probed yet)
      lastCheck: null,         // ISO string
      responseTimeMs: null,
      totalStreamsFound: 0,    // last probe's result count
      error: null,
      workingMovies: [],       // [{id,label,type,streams,lastWorking}]
      testedMovies: [],        // [{id,label,type,success,streamCount,responseTimeMs,error}]
      monitorError: null,
      lastMonitorAttempt: null,
      upStreak: 0,
      downStreak: 0,
      sweep: 0,
    };
    state.set(id, r);
  }
  return r;
}

async function probeSource(source, probe) {
  const t0 = Date.now();
  const rec = record(source.id, source.label || source.id);
  rec.lastMonitorAttempt = new Date().toISOString();
  const tested = {
    id: probe.raw,
    label: probe.label,
    type: probe.type || 'movie',
    success: false,
    streamCount: 0,
    responseTimeMs: 0,
    error: null,
  };
  try {
    let parsedId;
    if (probe.tmdb) {
      parsedId = { id: probe.tmdb, season: 1, episode: 1 };
    } else {
      parsedId = ImdbId.fromString(probe.raw); // tt ids parse directly; anime probe uses tmdb
    }
    const ctx = {
      hostUrl: new URL('https://source-monitor.local'),
      id: 'monitor',
      ip: '',
      config: { multi: 'on', en: 'on' },
    };
    const results = await Promise.race([
      source.handleInternal(ctx, tested.type, parsedId),
      new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), PROBE_TIMEOUT_MS)),
    ]);
    const dt = Date.now() - t0;
    tested.responseTimeMs = dt;
    if (results?.__timeout) {
      tested.error = 'timeout';
      rec.status = 'down';
      rec.error = 'Probe timed out';
      rec.downStreak++; rec.upStreak = 0;
    } else {
      const n = Array.isArray(results) ? results.length : 0;
      tested.streamCount = n;
      tested.success = n > 0;
      rec.totalStreamsFound = n;
      rec.responseTimeMs = dt;
      rec.error = n > 0 ? null : 'No results';
      rec.status = n > 0 ? 'up' : 'down';
      if (n > 0) { rec.upStreak++; rec.downStreak = 0; } else { rec.downStreak++; rec.upStreak = 0; }
    }
  } catch (e) {
    const dt = Date.now() - t0;
    tested.responseTimeMs = dt;
    tested.error = String(e?.message || e).slice(0, MAX_ERROR_LEN);
    rec.status = 'down';
    rec.error = tested.error;
    rec.downStreak++; rec.upStreak = 0;
  }
  rec.lastCheck = new Date().toISOString();
  rec.sweep = sweepCount;
  rec.monitorError = null;
  rec.testedMovies = [tested];
  rec.workingMovies = tested.success
    ? [{ id: tested.id, label: tested.label, type: tested.type, streams: tested.streamCount, lastWorking: rec.lastCheck }]
    : [];
  return tested.success;
}

// Second-chance probe for accuracy: an empty first probe can be a per-title
// catalog gap rather than an outage (the same false-negative class the probe
// rotation above addresses — production-measured on animeflix/animezey).
// Before recording "down", retry ONCE with the next probe title in the same
// rotation class. Bounded: at most 2 scrapes per source per sweep, and the
// empty path is the fast path (dead sources fail in seconds, not at the cap).
async function probeWithFallback(source, primary, secondary) {
  const ok = await probeSource(source, primary);
  if (ok || !started || !secondary) return ok;
  await waitWhilePlayback();
  if (!started) return false;
  return probeSource(source, secondary);
}

// Yield to playback: while a stream is actively serving through /proxy or
// /range-proxy, the Task 54 gate says background work must wait. Probes are
// background work. playbackGate.quient() resolves once playback has been idle
// for its settle window (bounded by maxMs, so sweeps still progress during
// very long continuous playback).
async function waitWhilePlayback(maxWaitMs = 60_000) {
  await playbackGate.quiet(maxWaitMs, 1_500);
}

async function runSweep(sources, animeOnlyIds) {
  sweepCount++;
  lastSweepStartedAt = new Date().toISOString();
  for (const source of sources) {
    if (!started) return; // shut down mid-sweep
    const isAnimeOnly = animeOnlyIds.has(source.id);
    let primary, secondary;
    if (isAnimeOnly) {
      primary = ANIME_PROBES[sweepCount % ANIME_PROBES.length];
      secondary = ANIME_PROBES[(sweepCount + 1) % ANIME_PROBES.length];
    } else {
      primary = MOVIE_PROBES[sweepCount % MOVIE_PROBES.length];
      secondary = MOVIE_PROBES[(sweepCount + 1) % MOVIE_PROBES.length];
    }
    try {
      await waitWhilePlayback();
      if (!started) return;
      await probeWithFallback(source, primary, secondary);
    } catch {
      // probeSource already records errors; a throw here must never kill the loop
    }
    // gap between probes — keeps average load at ~one scrape per 25s
    for (let waited = 0; started && waited < GAP_BETWEEN_PROBES_MS; waited += 2_500) {
      await new Promise(r => setTimeout(r, 2_500));
    }
  }
  lastSweepFinishedAt = new Date().toISOString();
}

export function startSourceMonitor(sources, animeOnlyIds) {
  if (started) return;
  if (String(process.env.PHOENIX_SOURCE_MONITOR || '') === '0') return;
  if (!Array.isArray(sources) || sources.length === 0) return;
  started = true;
  const set = animeOnlyIds instanceof Set ? animeOnlyIds : new Set(animeOnlyIds || []);
  for (const s of sources) record(s.id, s.label || s.id);
  // First sweep starts after a short settle (let boot finish allocating).
  monitorTimer = setTimeout(() => {
    (async () => {
      while (started) {
        await runSweep(sources, set);
        // inter-sweep rest
        for (let waited = 0; started && waited < 60_000; waited += 5_000) {
          await new Promise(r => setTimeout(r, 5_000));
        }
      }
    })().catch(() => {});
  }, 20_000);
  if (monitorTimer.unref) monitorTimer.unref();
}

export function stopSourceMonitor() {
  started = false;
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
}

// Reference-compatible /api/status payload. Sources not yet probed this boot have
// status:null → served as "unknown" (amber) — honest, never guessed.
export function getMonitorStatus() {
  const providers = {};
  for (const [id, r] of state) {
    providers[id] = {
      id: r.id,
      name: r.name,
      status: r.status || 'unknown',
      lastCheck: r.lastCheck,
      workingMovies: r.workingMovies,
      testedMovies: r.testedMovies,
      error: r.error,
      totalStreamsFound: r.totalStreamsFound,
      responseTimeMs: r.responseTimeMs,
      monitorError: r.monitorError,
      lastMonitorAttempt: r.lastMonitorAttempt,
      upStreak: r.upStreak,
      downStreak: r.downStreak,
    };
  }
  return {
    providers,
    lastUpdated: lastSweepFinishedAt || lastSweepStartedAt,
    sweepCount,
    monitoring: started,
  };
}

export function getMonitorInfo() {
  return {
    started,
    sweepCount,
    lastSweepStartedAt,
    lastSweepFinishedAt,
    tracked: state.size,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    gapMs: GAP_BETWEEN_PROBES_MS,
  };
}
