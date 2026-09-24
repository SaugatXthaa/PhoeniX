// Task 87: AcerMovies canary + negative-cache E2E against a live local boot.
import { spawn } from 'node:child_process';

const REPO = '/home/z/my-project/phoenix-analysis';
const PORT = '4599';
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn('node', ['src/index.js'], { cwd: REPO, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] });
let bootLog = '';
child.stdout.on('data', d => { bootLog += d; });
child.stderr.on('data', d => { bootLog += d; });

const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) break;
  } catch { }
  await new Promise(r => setTimeout(r, 1500));
}
console.log('server booted\n');

async function probe(type, id, label) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/debug/source/acermovies?type=${type}&id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(50000) });
  const j = await r.json().catch(() => ({}));
  const dt = Date.now() - t0;
  console.log(`===== ${label} → count=${j.count} ${j.timedOut ? 'TIMEDOUT' : ''} ${dt}ms (server ${j.durationMs}ms) err=${j.error || '-'}`);
  for (const l of (j.logs || [])) console.log('   ', l.slice(0, 170));
  return j;
}

// 1. Inception — expect canary short-circuit, NO "empty resolve attempt" ladder
await probe('movie', 'tmdb:27205', 'Inception 1st (canary short-circuit)');

// 2. Same id — expect negative-cache hit, near-zero upstream traffic
await probe('movie', 'tmdb:27205', 'Inception 2nd (negative cache)');

// 3. Dune2 — fresh id, another definitive miss path
await probe('movie', 'tmdb:693134', 'Dune2 (definitive miss)');

// 4. Series — unsupported-by-design sentinel path
await probe('series', 'tmdb:1396:1:1', 'BB S1E1 (series sentinel)');

child.kill('SIGKILL');
console.log('\nE2E done');
