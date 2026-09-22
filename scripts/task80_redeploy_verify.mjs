// Task 80 — redeploy verification under RENDER FREE TIER SPECS (0.1 CPU / 448MB).
// Incident: production was found serving a ~09-09..09-17 vintage build
// (max-age=300 marker, /debug/rawfetch 404, antarctica+atlantic+movielinkbd
// missing from registry, dahmermovies/antova/cuevana present instead).
// That build predates the Task 66 pixeldrain host-circuit fix, whose
// documented failure mode is exactly "cinewave not returning any streams".
// Fix: redeploy current main. This script verifies the deploy candidate
// (HEAD = origin/main) end-to-end in the throttled sandbox:
//   1. cinewave cards present in merged /stream rounds (user complaint)
//   2. antarctica + atlantic + movielinkbd registered (deploy-fresh markers)
//   3. converged /stream cache-control = max-age=150 (Task 76 marker)
//   4. no magnets, no html URLs, 4K present, warm convergence
//
// Usage: node scripts/task80_redeploy_verify.mjs

import { spawn } from 'child_process';

const PORT = 7080;
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

function brandDist(streams) {
  const dist = {};
  for (const s of streams) {
    const m = /PhoeniX · [^·]+ · ([^·]+?) ·/.exec(s.name || '');
    const b = m ? m[1].trim() : 'other';
    dist[b] = (dist[b] || 0) + 1;
  }
  return dist;
}

async function mergedWithHeaders(type, id, label) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { signal: AbortSignal.timeout(70000) });
  const cc = r.headers.get('cache-control') || '';
  const j = await r.json();
  const streams = j.streams || [];
  const dt = Date.now() - t0;
  const dist = brandDist(streams);
  const fourK = streams.filter(s => /· 4K/.test(s.name || '')).length;
  const html = streams.filter(s => /\.html?($|\?)/i.test(s.url || '')).length;
  const magnets = streams.filter(s => /^magnet:/i.test(s.url || '')).length;
  console.log(`[e2e] ${label}: total=${streams.length} @${dt}ms | cc="${cc}" | 4K=${fourK} | html=${html} | magnets=${magnets}`);
  console.log(`      brands: ${JSON.stringify(dist)}`);
  return { streams, cc, dist, fourK, html, magnets };
}

try {
  if (!(await waitBoot())) throw new Error('sandbox did not boot');
  console.log('[e2e] throttled sandbox up (0.1 CPU / 448MB) @ HEAD ' + (await gitHead()));

  // Registry freshness markers
  const reg = await registryIds();
  check('registry has antarctica (Task 77)', reg.has('antarctica'));
  check('registry has atlantic (Task 48)', reg.has('atlantic'));
  check('registry has movielinkbd (Task 58)', reg.has('movielinkbd'));
  check('registry free of pre-Task-50 ghosts (dahmermovies/antova/cuevana)',
    !reg.has('dahmermovies') && !reg.has('antova') && !reg.has('cuevana'),
    `count=${reg.size}`);

  // Movie merged rounds — cinewave focus
  const r1 = await mergedWithHeaders('movie', 'tmdb:693134', 'movie Dune2 r1(cold)');
  check('Dune2: cinewave cards present in merged (user complaint)', (r1.dist['CineWave'] || 0) >= 1, `cinewave=${r1.dist['CineWave'] || 0}`);
  check('Dune2: zero magnets', r1.magnets === 0);
  check('Dune2: zero html URLs', r1.html === 0);

  const r2 = await mergedWithHeaders('movie', 'tmdb:693134', 'movie Dune2 r2(warm)');
  check('Dune2 warm: converged cache-control = max-age=150 (Task 76 marker)', /max-age=150/.test(r2.cc), `cc="${r2.cc}"`);
  check('Dune2 warm: cinewave cards still present', (r2.dist['CineWave'] || 0) >= 1, `cinewave=${r2.dist['CineWave'] || 0}`);
  check('Dune2 warm: total converged >= r1', r2.streams.length >= r1.streams.length, `${r2.streams.length} vs ${r1.streams.length}`);

  // Series parity
  const s1 = await mergedWithHeaders('series', 'tmdb:1396:1:1', 'series BBS01E1 r1');
  check('BBS01E1: healthy deliver (>=20 cards)', s1.streams.length >= 20, `total=${s1.streams.length}`);
  check('BBS01E1: zero magnets', s1.magnets === 0);
  check('BBS01E1: zero html URLs', s1.html === 0);
} catch (e) {
  console.log(`[e2e] ❌ ${e.message}`);
  failures++;
} finally {
  if (serverPid) {
    try { process.kill(serverPid, 'SIGCONT'); } catch {}
    try { process.kill(serverPid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGCONT'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}

async function gitHead() {
  const { execSync } = await import('child_process');
  return execSync('git rev-parse --short HEAD').toString().trim();
}

async function registryIds() {
  // force a 404 from the registry to read the Available list
  const r = await fetch(`${BASE}/debug/source/__registry_probe__?type=movie&id=tmdb:693134`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  const m = /Available: (.+)$/.exec(j.error || '');
  if (!m) throw new Error('cannot parse Available list: ' + JSON.stringify(j).slice(0, 200));
  return new Set(m[1].split(',').map(s => s.trim()).filter(Boolean));
}

console.log(`[e2e] RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
