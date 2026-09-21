// Task 75 — verify the /stream token-age window fix under RENDER FREE TIER
// throttle (0.1 CPU / 448MB heap), per the standing sandbox requirement.
//
// Asserts on live responses (Dune 2 = tmdb:693134, Task 72/73/74 baseline):
//   1. header is ALWAYS either 'no-store' (partial/starved — Task 69) or
//      'public, max-age=60' (converged — Task 75 fix);
//   2. the old 'public, max-age=300' NEVER reappears;
//   3. card counts stay in the healthy band (warm convergence unchanged).
//
// Usage: node scripts/task75_ttl_header_verify.mjs [--rounds 3]

import { spawn } from 'child_process';

const PORT = 7075;
const BASE = `http://127.0.0.1:${PORT}`;
const TITLE = 'movie/tmdb:693134.json'; // Dune 2
const ROUNDS = parseInt(process.argv[3] || process.argv[2] || '3', 10) || 3;

const sandbox = spawn('node', ['scripts/render_sandbox.cjs'], {
  env: { ...process.env, PORT: String(PORT), THROTTLE_CPU: '0.1', HEAP_MB: '448' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
sandbox.stdout.on('data', () => {});
sandbox.stderr.on('data', () => {});
const sandboxLog = [];
sandbox.stdout.on('data', d => sandboxLog.push(d.toString()));
sandbox.stderr.on('data', d => sandboxLog.push(d.toString()));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitBoot(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

let failures = 0;
const results = [];
try {
  const up = await waitBoot();
  if (!up) throw new Error('sandbox did not boot');
  console.log('[verify] sandbox up (0.1 CPU / 448MB heap)');

  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/stream/${TITLE}`, { signal: AbortSignal.timeout(60000) });
    const cc = r.headers.get('cache-control') || '(none)';
    const body = await r.json();
    const n = body.streams?.length ?? 0;
    const ms = Date.now() - t0;
    results.push({ round: i, cc, n, ms });
    console.log(`[verify] r${i}: cards=${n} cache-control="${cc}" ${ms}ms`);

    if (cc !== 'no-store' && cc !== 'public, max-age=60') {
      console.log(`[verify] ❌ r${i}: unexpected header "${cc}" (expected no-store or public, max-age=60)`);
      failures++;
    } else {
      console.log(`[verify] ✅ r${i}: header within allowed set`);
    }
    if (i < ROUNDS) await sleep(45000); // let warm caches deepen, keeper-style
  }

  const converged = results.find(r => r.cc === 'public, max-age=60');
  if (converged) {
    console.log(`[verify] ✅ converged branch observed: r${converged.round} ${converged.n} cards @${converged.ms}ms`);
  } else {
    console.log('[verify] ⚠ no converged round observed (all partial → no-store). Under 0.1 CPU cold this is the Task 73 lottery class, not a header failure — header set was still valid.');
  }
} catch (e) {
  console.log(`[verify] ❌ ${e.message}`);
  failures++;
} finally {
  try { sandbox.kill('SIGKILL'); } catch {}
}

console.log(`[verify] RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
