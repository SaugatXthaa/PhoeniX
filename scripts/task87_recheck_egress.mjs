// Task 87: re-check the 4 egress-class sources (hindmoviez, kmmovies, animezey, acermovies)
// to catch a Render IP rotation. Step 1: current prod egress IP (vs 74.220.48.71 from Task 83).
// Step 2: /debug/source probes mirroring the Task 86 protocol.
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';

const MOVIE1 = 'tmdb:693134';   // Dune: Part Two
const MOVIE2 = 'tmdb:27205';    // Inception
const SERIES1 = 'tmdb:1396:1:1'; // Breaking Bad S1E1
const SERIES2 = 'tmdb:93405:1:1'; // Squid Game S1E1
const ANIME1 = 'tmdb:95479:1:1'; // Jujutsu Kaisen S1E1
const ANIME2 = 'tmdb:209867:2:1'; // Frieren S2E1

// ---- Step 1: egress IP ----
console.log('===== STEP 1: PROD EGRESS IP =====');
let egress = { ip: 'unknown' };
for (const svc of ['https://api.ipify.org?format=json', 'https://ipinfo.io/json']) {
  try {
    const u = `${PROD}/debug/rawfetch?url=${encodeURIComponent(svc)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    const body = j.body ?? JSON.stringify(j).slice(0, 400);
    console.log(`svc=${svc} status=${j.status} body=${String(body).slice(0, 200)}`);
    try {
      const parsed = JSON.parse(body);
      if (parsed.ip) { egress = parsed; break; }
    } catch { /* try next */ }
  } catch (e) {
    console.log(`svc=${svc} failed: ${e.message}`);
  }
}
console.log('EGRESS IP:', egress.ip, '| previous (Task 83): 74.220.48.71 |',
  egress.ip === '74.220.48.71' ? 'NO ROTATION' : 'ROTATION DETECTED');

// ---- Step 2: re-probe the 4 egress-class sources ----
console.log('\n===== STEP 2: EGRESS-CLASS RE-PROBES =====');
const PROBES = [
  ['acermovies',  'movie',  MOVIE1,  'Dune2'],
  ['acermovies',  'movie',  MOVIE2,  'Inception'],
  ['acermovies',  'series', SERIES1, 'BB'],
  ['acermovies',  'series', SERIES2, 'Squid'],
  ['kmmovies',    'movie',  MOVIE1,  'Dune2'],
  ['kmmovies',    'movie',  MOVIE2,  'Inception'],
  ['kmmovies',    'series', SERIES1, 'BB'],
  ['kmmovies',    'series', SERIES2, 'Squid'],
  ['hindmoviez',  'movie',  MOVIE1,  'Dune2'],
  ['hindmoviez',  'movie',  MOVIE2,  'Inception'],
  ['hindmoviez',  'series', SERIES1, 'BB'],
  ['hindmoviez',  'series', SERIES2, 'Squid'],
  ['animezey',    'anime',  ANIME1,  'JJK'],
  ['animezey',    'anime',  ANIME2,  'Frieren'],
];

import fs from 'fs';
const OUT = '/home/z/my-project/scripts/task87_recheck_results.json';
const results = [];
let idx = 0;

async function probeOne([id, type, rid, label]) {
  const url = `${PROD}/debug/source/${id}?type=${type}&id=${encodeURIComponent(rid)}`;
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 55000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(tm);
    const j = await res.json().catch(() => ({}));
    return {
      id, type, rid, label,
      count: j.count ?? j.results?.length ?? 0,
      durationMs: j.durationMs ?? (Date.now() - t0),
      timedOut: j.timedOut || false,
      error: j.error ? String(j.error).slice(0, 300) : null,
      http: res.status,
      logs: (j.logs || []).slice(-20),
      at: new Date().toISOString(),
    };
  } catch (e) {
    return { id, type, rid, label, count: 0, durationMs: Date.now() - t0, timedOut: false, error: 'client: ' + e.message, http: 0, logs: [], at: new Date().toISOString() };
  }
}

async function pool(conc) {
  const workers = Array.from({ length: conc }, async () => {
    while (idx < PROBES.length) {
      const p = PROBES[idx++];
      const r = await probeOne(p);
      const tag = r.count > 0 ? 'HIT ' : 'ZERO';
      console.log(`[${tag}] ${r.id} ${r.type}/${r.label} count=${r.count} ${r.durationMs}ms err=${r.error ? String(r.error).slice(0, 100) : '-'}`);
      results.push(r);
      fs.writeFileSync(OUT, JSON.stringify({ egress, results }, null, 1));
    }
  });
  await Promise.all(workers);
}

const t0 = Date.now();
await pool(3);
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Results: ${OUT}`);

const bySrc = {};
for (const r of results) (bySrc[r.id] = bySrc[r.id] || []).push(r);
console.log('\n===== SUMMARY =====');
for (const [id, rs] of Object.entries(bySrc)) {
  const total = rs.reduce((a, b) => a + (b.count || 0), 0);
  console.log(`${id}: total=${total} | ${rs.map(r => `${r.label}:${r.count}@${(r.durationMs / 1000).toFixed(1)}s`).join(' ')}`);
}
