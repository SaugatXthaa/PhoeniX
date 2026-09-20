// Task 65: local E2E — boot the addon and probe all changed sources
const { spawn } = require('child_process');
const child = spawn('node', ['src/index.js'], { env: { ...process.env, PORT: '4676', STREAM_CLIENT_BUDGET_MS: '40000' }, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', d => { const s = String(d); if (/Unhandled|crash/i.test(s)) process.stderr.write(s.slice(0, 300)); });
const BASE = 'http://127.0.0.1:4676';

(async () => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) }); break; }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  console.log('server up');

  const probes = [
    ['movielinkbd', 'series', 'tmdb:1399:1:1'],
    ['movieshuntv2', 'series', 'tmdb:95479:1:1'],
    ['desiflix', 'movie', 'tmdb:27205'],
    ['hindmoviez', 'movie', 'tmdb:27205'],
    ['cinehdplus', 'series', 'tmdb:1399:1:1'],
    ['kmmovies', 'movie', 'tmdb:27205'],
  ];
  for (const [sid, type, id] of probes) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/debug/source/${sid}?type=${type}&id=${id}`, { headers: { 'x-request-id': 't65-local' }, signal: AbortSignal.timeout(75000) });
      const j = await r.json();
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${sid.padEnd(14)} ${type.padEnd(7)} count=${String(j.count).padStart(3)} ${dur}s ${j.error ? 'ERR:' + String(j.error).slice(0, 50) : ''}`);
    } catch (e) {
      console.log(`${sid.padEnd(14)} probe ERR ${String(e).slice(0, 60)}`);
    }
  }
  child.kill('SIGTERM');
  process.exit(0);
})().catch(e => { child.kill(); console.error(e); process.exit(1); });
