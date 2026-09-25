// src/utils/SourceStatus.js
//
// Task 90 — SOURCE STATUS: passive per-source outcome recorder + the data
// model behind the non-technical /status live page.
//
// WHERE THE DATA COMES FROM (two sources, zero extra upstream load):
//   1. PASSIVE — StreamResolver already measures every source on every real
//      resolve (status ok/timeout/error, result count, duration). One Map
//      update per settled source (recordSourceOutcome) captures it. Cache
//      hits included: what a user would actually get is what gets recorded.
//   2. ACTIVE — the Task 89 EgressWatch probes (kmmovies/acer) are merged at
//      read time; they are the only visibility into sources whose upstream
//      gate blocks real traffic anyway.
//
// SAFETY RULES:
//   - PASSIVE ONLY on user paths: recordSourceOutcome is a synchronous Map
//     write of primitives (~microseconds); no I/O, no locks, no fetches.
//   - BOUNDED memory: 69 sources × fixed-shape entries, counters only.
//   - READ-ONLY page: /status and /status/data never trigger resolves or
//     probes; they only render what already happened.
//   - Honest staleness: sources nobody requested recently show as "no
//     recent requests" rather than a fake verdict.

const MAX_ENTRIES = 200; // hard cap, defense against registry surprises
const state = new Map(); // sourceId -> entry

function entry(id) {
  let e = state.get(id);
  if (!e && state.size < MAX_ENTRIES) {
    e = { firstAt: Date.now(), last: null, totals: { ok: 0, zero: 0, err: 0 } };
    state.set(id, e);
  }
  return e;
}

// Called from StreamResolver's per-source finally — the single hottest loop in
// the addon. Keep it allocation-light: primitives only.
export function recordSourceOutcome(id, type, status, count, durationMs) {
  const e = entry(id);
  if (!e) return; // over cap — skip silently, telemetry must never throw
  e.last = { at: Date.now(), type: String(type || ''), status: String(status || ''), count: count | 0, ms: durationMs | 0 };
  if (status === 'ok') { if (count > 0) e.totals.ok++; else e.totals.zero++; }
  else e.totals.err++;
}

// Classification for the page. status: delivering | waiting | issue | idle
export function getSourceStatus() {
  const out = {};
  for (const [id, e] of state) {
    const last = e.last;
    let cls = 'idle';
    if (last) {
      if (last.status === 'ok' && last.count > 0) cls = 'delivering';
      else if (last.status === 'ok') cls = 'waiting';
      else cls = 'issue';
    }
    out[id] = {
      cls,
      count: last?.count || 0,
      ms: last?.ms || 0,
      type: last?.type || '',
      agoMs: last ? Date.now() - last.at : 0,
      totals: { ...e.totals },
      firstAt: e.firstAt,
    };
  }
  return out;
}

// Plain-language verdicts for the two actively-watched sources, driven by the
// Task 89 watch vocabulary. Returns {cls, note} or null when no watch data.
export function watchVerdictFor(id, watchSummary) {
  if (!watchSummary || (id !== 'kmmovies' && id !== 'acermovies')) return null;
  const w = watchSummary[id];
  if (!w) return { cls: 'waiting', note: 'Auto-probe scheduled — first check still warming up' };
  const v = String(w.verdict || '');
  const cadence = id === 'kmmovies' ? 'every 1.5 h' : 'every 3 h';
  if (/delivering|HEALED/.test(v)) {
    return { cls: 'delivering', note: `Recovered — auto-check ${cadence} confirmed it` };
  }
  if (/429-cooldown/.test(v)) {
    return { cls: 'waiting', note: `The site is rate-limiting the server — auto-checked ${cadence}, recovers on its own` };
  }
  if (/backend-cache-empty/.test(v)) {
    return { cls: 'waiting', note: `The site itself can't provide links right now (affects everyone) — auto-checked ${cadence}` };
  }
  if (/negative-cached/.test(v)) {
    return { cls: 'waiting', note: `Recently checked — nothing yet — auto-rechecks ${cadence}` };
  }
  if (/relay/.test(v)) {
    return { cls: 'waiting', note: `Site's direct API unreachable — probing via backup route ${cadence.replace('every', 'every')}` };
  }
  return { cls: 'waiting', note: `Waiting on the site — auto-checked ${cadence}` };
}
