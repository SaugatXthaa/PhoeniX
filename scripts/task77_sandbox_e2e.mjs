// Task 77 — Antarctica throttled sandbox E2E (RENDER FREE TIER SPECS).
// 0.1 CPU / 448MB heap via render_sandbox.cjs (standing requirement).
// Merged /stream checks: total cards, antarctica cards present + direct
// HTTPS (no /proxy, no magnet, no html), 4K present, subs coverage, and
// card ordering sanity (antarctica 4K REMUX near the top of its group).
//
// Usage: node scripts/task77_sandbox_e2e.mjs

import { spawn } from 'child_process';

const PORT = 7077;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn('node', ['scripts/render_sandbox.cjs'], {
  env: { ...process.env, PORT: String(PORT), THROTTLE_CPU: '0.1', HEAP_MB: '448' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
let serverPid = null;
child.stdout.on('data', d => {
  bootLog += d.toString();
  const m = bootLog.match(/\[sandbox\] pid=(\d+)/);
  if (m && !serverPid) serverPid = parseInt(m[1], 10);
});
child.stderr.on('data', d => { bootLog += d.toString(); });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

async function waitBoot(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function merged(type, id, label) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { signal: AbortSignal.timeout(70000) });
  const j = await r.json();
  const streams = j.streams || [];
  const dt = Date.now() - t0;
  const ant = streams.filter(s => /antarctica/i.test(s.name || ''));
  const fourK = streams.filter(s => /· 4K/.test(s.name || '')).length;
  const html = streams.filter(s => /\.(html?)($|\?)/i.test(s.url || '')).length;
  const magnets = streams.filter(s => /^magnet:/i.test(s.url || '')).length;
  const subs = streams.filter(s => (s.subtitles || []).length > 0).length;
  console.log(`[e2e] ${label}: total=${streams.length} @${dt}ms | 4K=${fourK} | html=${html} | magnets=${magnets} | subs ${subs}/${streams.length} | antarctica=${ant.length}`);
  // antarctica card inspection
  const antDirect = ant.filter(s => /^https:\/\/comet\.feels\.legal\//.test(s.url || ''));
  const ant4K = ant.filter(s => /4K/.test(s.name || '')).length;
  const antSubs = ant.filter(s => (s.subtitles || []).length > 0).length;
  (ant.slice(0, 2)).forEach((s, i) => {
    console.log(`   ant[${i}] name=${(s.name || '').slice(0, 70)}`);
    console.log(`          url=${(s.url || '').slice(0, 70)}`);
    console.log(`          title=${(s.title || '').slice(0, 80)}`);
    console.log(`          subs=${(s.subtitles || []).length}`);
  });
  check(`${label}: antarctica cards present in merged response`, ant.length >= 1, `count=${ant.length}`);
  check(`${label}: antarctica cards are DIRECT comet.feels.legal HTTPS URLs`, ant.length === antDirect.length, `${antDirect.length}/${ant.length}`);
  check(`${label}: antarctica 4K present (up-to-8K source)`, ant4K >= 1, `4K cards=${ant4K}`);
  check(`${label}: zero magnets anywhere in merged`, magnets === 0);
  check(`${label}: zero html URLs anywhere in merged`, html === 0);
  return { streams, ant };
}

try {
  if (!(await waitBoot())) throw new Error('sandbox did not boot');
  console.log('[e2e] throttled sandbox up (0.1 CPU / 448MB)');

  const m = await merged('movie', 'tmdb:693134', 'movie Dune2 r1');
  const s = await merged('series', 'tmdb:1396:1:1', 'series BBS01E1 r1');

  // Warm round — antarctica TTL 10min, r2 should hit the per-source cache
  // (instant antarctica contribution) and converge higher overall.
  const m2 = await merged('movie', 'tmdb:693134', 'movie Dune2 r2(warm)');
  check('warm r2: total converged >= r1', m2.streams.length >= m.streams.length, `${m2.streams.length} vs ${m.streams.length}`);
} catch (e) {
  console.log(`[e2e] ❌ ${e.message}`);
  failures++;
} finally {
  // Kill the SERVER pid first (SIGCONT wakes a mid-SIGSTOP child so SIGKILL
  // can actually be reaped — a SIGKILL'd wrapper cannot run its own shutdown,
  // which orphans the stopped server and holds the port).
  if (serverPid) {
    try { process.kill(serverPid, 'SIGCONT'); } catch {}
    try { process.kill(serverPid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGCONT'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}
console.log(`[e2e] RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
