#!/usr/bin/env node
// Task 98b — unit test for the SourceMonitor accuracy upgrade:
//   1. probe rotation: even/odd sweeps start with different titles
//   2. second-chance probe: an empty primary probe gets ONE fallback probe
//      with the next rotation title before "down" is recorded
//   3. a source that fails both attempts records down with the last error
// Runs against stub sources (no network). Exits 1 on any failure.
import { startSourceMonitor, stopSourceMonitor, getMonitorStatus } from '../src/utils/SourceMonitor.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// stub source: empty on the FIRST probe title each sweep, delivers on the
// second (catalog-gap class — the exact false-negative we are fixing)
let calls = [];
const catalogGapSource = {
  id: 'stubgap',
  label: 'Stub Gap',
  contentTypes: ['series'],
  async handleInternal(ctx, type, id) {
    calls.push(id.id);
    if (calls.length % 2 === 1) return []; // odd calls (primary) → empty
    return [{ url: 'https://example.invalid/a.m3u8', meta: {} }];
  },
};

const alwaysUp = {
  id: 'stubup', label: 'Stub Up', contentTypes: ['movie'],
  async handleInternal() { return [{ url: 'https://example.invalid/b.mkv', meta: {} }]; },
};

const alwaysDown = {
  id: 'stubdown', label: 'Stub Down', contentTypes: ['movie'],
  async handleInternal() { throw new Error('upstream dead (stub)'); },
};

// ANIME set membership → exercises the anime probe pair (2 entries)
startSourceMonitor([catalogGapSource, alwaysUp, alwaysDown], new Set(['stubgap']));
// sweep runs after a 20s settle in prod; shorten by waiting for the first
// probe to land (poll getMonitorStatus up to ~40s — stubs resolve instantly
// so the only waits are the module's settle timer + inter-probe gap)
const t0 = Date.now();
let snap = null;
while (Date.now() - t0 < 90_000) {
  await sleep(1000);
  snap = getMonitorStatus();
  const p = snap.providers || {};
  if (p.stubgap?.lastCheck && p.stubup?.lastCheck && p.stubdown?.lastCheck) break;
}
stopSourceMonitor();

ok('monitor started + probed all stubs', snap?.monitoring === true && Object.keys(snap.providers).length === 3);
ok('catalog-gap source rescued to UP by fallback probe', snap.providers.stubgap?.status === 'up',
  `calls=[${calls.join(',')}]`);
ok('always-up source is UP', snap.providers.stubup?.status === 'up');
ok('always-down source is DOWN with error', snap.providers.stubdown?.status === 'down'
  && String(snap.providers.stubdown?.error || '').includes('stub'));
ok('fallback kept probe count bounded (≤2 per source)', calls.length <= 4, `total stub calls=${calls.length}`);
ok('probe rotation actually alternates titles', new Set(calls).size === 2, `distinct probe ids=${[...new Set(calls)].join(',')}`);

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
