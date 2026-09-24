// Task 86b: SEQUENTIAL reprobe (no concurrency → no console-capture bleed)
// for the sources whose diagnosis is still uncertain.
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';
const PROBES = [
  ['hindmoviez',  'movie',  'tmdb:693134', 'Dune2'],
  ['hindmoviez',  'series', 'tmdb:1396:1:1', 'BB'],
  ['acermovies',  'movie',  'tmdb:27205', 'Inception'],
  ['kmmovies',    'movie',  'tmdb:27205', 'Inception'],
  ['zxcstream',   'movie',  'tmdb:27205', 'Inception'],
  ['animezey',    'anime',  'tmdb:95479:1:1', 'JJK'],
];

import fs from 'fs';
const out = [];
for (const [id, type, rid, label] of PROBES) {
  const url = `${PROD}/debug/source/${id}?type=${type}&id=${encodeURIComponent(rid)}`;
  process.stdout.write(`probing ${id}/${label}... `);
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 60000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(tm);
    const j = await res.json().catch(() => ({}));
    console.log(`count=${j.count ?? 'ERR'} ${(Date.now() - t0) / 1000 | 0}s err=${j.error ? String(j.error).slice(0, 60) : '-'}`);
    out.push({ id, type, rid, label, count: j.count ?? null, durationMs: j.durationMs, error: j.error || null, logs: j.logs || [] });
  } catch (e) {
    console.log('FAIL ' + e.message);
    out.push({ id, type, rid, label, count: null, error: 'client: ' + e.message, logs: [] });
  }
}
fs.writeFileSync('/home/z/my-project/scripts/task86b_seq_results.json', JSON.stringify(out, null, 1));
console.log('\nsaved task86b_seq_results.json');
