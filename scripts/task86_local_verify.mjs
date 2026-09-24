// Task 86: local verification — spawn the addon, probe the 5 fixed sources
// (atlantic, zxcstream, meinecloud, cinehdplus, verhdlink) via /debug/source.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = '/home/z/my-project/ignatiusphoenix';
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

const PROBES = [
  ['atlantic',    'movie',  'tmdb:693134', 'Dune2'],
  ['atlantic',    'series', 'tmdb:1396:1:1', 'BB'],
  ['zxcstream',   'movie',  'tmdb:27205', 'Inception'],
  ['meinecloud',  'movie',  'tmdb:27205', 'Inception'],
  ['cinehdplus',  'series', 'tmdb:1396:1:1', 'BB'],
  ['cinehdplus',  'series', 'tmdb:93405:1:1', 'Squid'],
  ['verhdlink',   'movie',  'tmdb:15239678'.replace('tmdb:','tmdb:'), 'Dune2'], // placeholder fixed below
  ['verhdlink',   'movie',  'tmdb:693134', 'Dune2'],
];

const child = spawn('node', [path.join(REPO, 'src/index.js')], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let booted = false;
child.stdout.on('data', (d) => { if (String(d).includes('listening') || String(d).includes('started')) booted = true; });
child.stderr.on('data', (d) => process.stdout.write('[addon-err] ' + String(d).slice(0, 200)));

// wait for /health
let healthy = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) { healthy = true; break; }
  } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 500));
}
console.log('addon healthy:', healthy);
if (!healthy) { child.kill('SIGKILL'); process.exit(1); }

for (const [id, type, rid, label] of PROBES) {
  if (rid !== 'tmdb:693134' && rid !== 'tmdb:27205' && rid !== 'tmdb:1396:1:1' && rid !== 'tmdb:93405:1:1') continue;
  const url = `${BASE}/debug/source/${id}?type=${type}&id=${encodeURIComponent(rid)}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(70000) });
    const j = await r.json();
    const count = j.count ?? 'ERR';
    console.log(`[${count === 0 ? 'ZERO' : 'HIT '}] ${id} ${type}/${label} count=${count} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (j.results && j.results.length) j.results.slice(0, 2).forEach(s => console.log('     ', (s.meta?.title || '').slice(0, 70), '|', String(s.url).slice(0, 80)));
    if (count === 0 || count === 'ERR') (j.logs || []).slice(-5).forEach(l => console.log('     log:', l.slice(0, 110)));
  } catch (e) {
    console.log(`[FAIL] ${id} ${type}/${label}: ${e.message.slice(0, 80)}`);
  }
}

child.kill('SIGKILL');
console.log('done');
