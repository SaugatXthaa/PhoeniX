#!/usr/bin/env node
// task74_keeper_e2e.mjs — end-to-end proof of the idle Cache-Keeper under
// RENDER FREE TIER SPECS (0.1 CPU via render_sandbox.cjs throttle, 448MB heap).
//
// Proof structure (timeline, all under throttle):
//   t=0     boot sandbox (keeper fast-mode env: idle 30s / tick 30s)
//   t≈boot  /health must expose the new telemetry fields
//   t0      /stream/movie/tmdb:693134 (Dune 2) — COLD r1 baseline
//   ...     NO more /stream from this script (probes count as user activity
//           and would idle-delay the keeper); only /health polls (non-activity)
//   ≥t0+30s keeper pass #1 fires (mostly cache-hits of r1) — assert passes≥1
//   t0+15m  per-source caches (15min TTL) EXPIRE — without the keeper the
//           next open would be a full-cold lottery again
//   t0+17m  final /stream probe — MUST be warm-class (> r1 + 10 cards) with
//           ZERO intermediate refreshes. That is the keeper's whole point.
//
// Verdict lines printed at the end; exit code 0 only on PASS.

import { spawn } from 'child_process';

const PORT = 7070;
const BASE = `http://localhost:${PORT}`;
const DUNE = 'movie/tmdb:693134';
const FINAL_AT_MS = 17 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jget(path, timeoutMs = 90000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ac.signal });
    clearTimeout(t);
    return await r.json();
  } catch (e) { clearTimeout(t); return null; }
}

function counts(streams) {
  const s = Array.isArray(streams) ? streams : [];
  const fourK = s.filter(x => (x.name || '').includes('4K')).length;
  const html = s.filter(x => /^https?:\/\/.+\.(html?|php)(\?|$)/i.test(x.url || '')).length;
  return { total: s.length, fourK, html };
}

console.log('[e2e] starting throttled sandbox (0.1 CPU, keeper fast-mode idle=30s tick=30s)');
const sandbox = spawn('node', ['scripts/render_sandbox.cjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(PORT), THROTTLE_CPU: '0.1', HEAP_MB: '448',
    CACHE_KEEPER_IDLE_MS: '30000', CACHE_KEEPER_TICK_MS: '30000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logLines = [];
sandbox.stdout.on('data', d => {
  for (const ln of d.toString().split('\n')) {
    if (!ln.trim()) continue;
    logLines.push(ln);
    if (/cache-keeper|listening|warm|exited|\[sandbox\]/i.test(ln)) console.log(`  | ${ln}`);
  }
});
sandbox.stderr.on('data', d => { const s = d.toString().trim(); if (s) { logLines.push(s); console.log(`  ! ${s}`); } });
const cleanup = () => { console.log('[e2e] cleanup — stopping sandbox'); try { sandbox.kill('SIGTERM'); } catch {} };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
sandbox.on('exit', (c) => { if (!finished) { console.error(`[e2e] FAIL: sandbox exited early code=${c}`); process.exit(1); } });

let finished = false;

// wait for listen
let h = null;
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  h = await jget('/health', 5000);
  if (h) break;
}
if (!h) { console.error('[e2e] FAIL: server never came up'); finished = true; sandbox.kill('SIGTERM'); process.exit(1); }
console.log(`[e2e] server up — bootAt=${h.bootAt} inst=${h.instanceId} rss=${h.memoryMB?.rss}MB keeperEnabled=${h.cacheKeeper?.enabled}`);

const telemetryOk = !!(h.bootAt && h.instanceId && h.memoryMB && h.keepalive && h.cacheKeeper);
console.log(`[e2e] ${telemetryOk ? 'PASS' : 'FAIL'}: /health telemetry fields present`);
const rootHitsBefore = h.keepalive.rootHits;

// t0 — cold r1
const t0 = Date.now();
const r1 = await jget(`/stream/${DUNE}.json`);
const c1 = counts(r1?.streams);
console.log(`[e2e] COLD r1 @+${((Date.now() - t0) / 1000).toFixed(1)}s: ${c1.total} cards (4K=${c1.fourK} html=${c1.html})`);
if (!c1.total) { console.error('[e2e] FAIL: r1 returned nothing'); finished = true; cleanup(); process.exit(1); }

// idle window — poll /health only (NOT /stream)
let passSeen = null;
while (Date.now() - t0 < 5 * 60 * 1000) {
  await sleep(10000);
  const hh = await jget('/health', 8000);
  if (hh?.cacheKeeper?.stats?.passes >= 1) { passSeen = hh.cacheKeeper; break; }
}
if (passSeen) {
  const s = passSeen.stats;
  console.log(`[e2e] PASS: keeper pass #1 observed @+${((s.lastPassAt - t0) / 1000).toFixed(0)}s — warmed=${s.lastPassWarmed} results=${s.lastPassResults} errors=${s.lastPassErrors} ${s.lastPassMs}ms`);
} else {
  console.log('[e2e] FAIL: no keeper pass within 5 min of the r1 request');
}

// quiet period until caches expire (15min TTL) + margin
const quietEnd = t0 + FINAL_AT_MS;
while (Date.now() < quietEnd) {
  await sleep(30000);
  const hh = await jget('/health', 8000); // /health is NOT user activity
  if (hh?.cacheKeeper?.stats?.passes) {
    const s = hh.cacheKeeper.stats;
    process.stdout.write(`  …t+${((Date.now() - t0) / 60000).toFixed(1)}m passes=${s.passes} lastPass(results=${s.lastPassResults}, ${s.lastPassMs}ms${s.lastPassYielded ? ', YIELDED' : ''})\r\n`);
  }
}

// final probe — the TTL-expiry proof
const rf = await jget(`/stream/${DUNE}.json`);
const cf = counts(rf?.streams);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[e2e] FINAL @t0+${dt}s (${(FINAL_AT_MS / 60000).toFixed(0)}min after the ONLY user request, caches expired at 15min): ${cf.total} cards (4K=${cf.fourK} html=${cf.html})`);
const hEnd = await jget('/health', 8000);
const sEnd = hEnd?.cacheKeeper?.stats || {};
console.log(`[e2e] keeper end-state: passes=${sEnd.passes} totalWarmedResults(last)=${sEnd.lastPassResults} yields=${sEnd.lastPassYielded} skippedActive=${sEnd.skippedActive} skippedMemory=${sEnd.skippedMemory}`);
const rootHitsAfter = hEnd?.keepalive?.rootHits ?? rootHitsBefore;

const pass = c1.total > 0 && cf.total > c1.total + 10 && cf.html === 0 && (sEnd.passes || 0) >= 2;
console.log('\n=== VERDICT ===');
console.log(`cold r1 = ${c1.total}; warm-after-TTL-expiry r1 = ${cf.total}; keeper passes = ${sEnd.passes}`);
console.log(pass ? 'PASS — keeper held the title warm across TTL expiry (no refreshes)' : 'FAIL — inspect pass stats above');
finished = true;
sandbox.kill('SIGTERM');
process.exit(pass ? 0 : 1);
