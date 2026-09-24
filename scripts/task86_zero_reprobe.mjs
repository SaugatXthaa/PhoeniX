// Task 86: fresh re-probe of the 12 zero sources from Task 85d census.
// Mirrors the census probe set, captures full logs for diagnosis.
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';

const MOVIE1 = 'tmdb:693134';   // Dune: Part Two
const MOVIE2 = 'tmdb:27205';    // Inception
const SERIES1 = 'tmdb:1396:1:1'; // Breaking Bad S1E1
const SERIES2 = 'tmdb:93405:1:1'; // Squid Game S1E1
const ANIME1 = 'tmdb:95479:1:1'; // Jujutsu Kaisen S1E1
const ANIME2 = 'tmdb:209867:2:1'; // Frieren S2E1

// [sourceId, type, rid, label]
const PROBES = [
  ['verhdlink',   'movie',  MOVIE1,  'Dune2'],
  ['verhdlink',   'movie',  MOVIE2,  'Inception'],
  ['verhdlink',   'series', SERIES1, 'BB'],
  ['verhdlink',   'series', SERIES2, 'Squid'],
  ['meinecloud',  'movie',  MOVIE1,  'Dune2'],
  ['meinecloud',  'movie',  MOVIE2,  'Inception'],
  ['meinecloud',  'series', SERIES1, 'BB'],
  ['meinecloud',  'series', SERIES2, 'Squid'],
  ['zxcstream',   'movie',  MOVIE1,  'Dune2'],
  ['zxcstream',   'movie',  MOVIE2,  'Inception'],
  ['zxcstream',   'series', SERIES1, 'BB'],
  ['zxcstream',   'series', SERIES2, 'Squid'],
  ['acermovies',  'movie',  MOVIE1,  'Dune2'],
  ['acermovies',  'movie',  MOVIE2,  'Inception'],
  ['acermovies',  'series', SERIES1, 'BB'],
  ['acermovies',  'series', SERIES2, 'Squid'],
  ['cinehdplus',  'movie',  MOVIE1,  'Dune2'],
  ['cinehdplus',  'movie',  MOVIE2,  'Inception'],
  ['cinehdplus',  'series', SERIES1, 'BB'],
  ['cinehdplus',  'series', SERIES2, 'Squid'],
  ['kmmovies',    'movie',  MOVIE1,  'Dune2'],
  ['kmmovies',    'movie',  MOVIE2,  'Inception'],
  ['kmmovies',    'series', SERIES1, 'BB'],
  ['kmmovies',    'series', SERIES2, 'Squid'],
  ['hindmoviez',  'movie',  MOVIE1,  'Dune2'],
  ['hindmoviez',  'movie',  MOVIE2,  'Inception'],
  ['hindmoviez',  'series', SERIES1, 'BB'],
  ['hindmoviez',  'series', SERIES2, 'Squid'],
  ['persianstremio', 'movie',  MOVIE1,  'Dune2'],
  ['persianstremio', 'movie',  MOVIE2,  'Inception'],
  ['persianstremio', 'series', SERIES1, 'BB'],
  ['persianstremio', 'series', SERIES2, 'Squid'],
  ['atlantic',    'movie',  MOVIE1,  'Dune2'],
  ['atlantic',    'series', SERIES1, 'BB'],
  ['atlantic',    'anime',  ANIME1,  'JJK'],
  ['animeflix',   'anime',  ANIME1,  'JJK'],
  ['animeflix',   'anime',  ANIME2,  'Frieren'],
  ['animezey',    'anime',  ANIME1,  'JJK'],
  ['animezey',    'anime',  ANIME2,  'Frieren'],
  ['rivestream',  'movie',  MOVIE1,  'Dune2'],
  ['rivestream',  'series', SERIES1, 'BB'],
  ['rivestream',  'anime',  ANIME1,  'JJK'],
];

const CONC = 4;
const results = [];
let idx = 0;

async function probeOne([id, type, rid, label]) {
  const url = `${PROD}/debug/source/${id}?type=${type}&id=${encodeURIComponent(rid)}`;
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 50000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(tm);
    const j = await res.json().catch(() => ({}));
    const rec = {
      id, type, rid, label,
      count: j.count ?? null,
      durationMs: j.durationMs ?? (Date.now() - t0),
      timedOut: j.timedOut || false,
      error: j.error ? String(j.error).slice(0, 300) : null,
      http: res.status,
      logs: (j.logs || []).slice(-25),
      at: new Date().toISOString(),
    };
    return rec;
  } catch (e) {
    return { id, type, rid, label, count: null, durationMs: Date.now() - t0, timedOut: false, error: 'client: ' + e.message, http: 0, logs: [], at: new Date().toISOString() };
  }
}

async function pool() {
  const workers = Array.from({ length: CONC }, async () => {
    while (idx < PROBES.length) {
      const p = PROBES[idx++];
      const r = await probeOne(p);
      const tag = r.count > 0 ? 'HIT ' : 'ZERO';
      console.log(`[${tag}] ${r.id} ${r.type}/${r.label} count=${r.count} ${r.durationMs}ms err=${r.error ? String(r.error).slice(0, 80) : '-'}`);
      results.push(r);
      // persist incrementally
      fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    }
  });
  await Promise.all(workers);
}

import fs from 'fs';
const OUT = '/home/z/my-project/scripts/task86_reprobe_results.json';
console.log(`Probing ${PROBES.length} probes across 12 zero sources...`);
const t0 = Date.now();
await pool();
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Results: ${OUT}`);

// summary
const bySrc = {};
for (const r of results) {
  bySrc[r.id] = bySrc[r.id] || [];
  bySrc[r.id].push(r);
}
console.log('\n===== SUMMARY =====');
for (const [id, rs] of Object.entries(bySrc)) {
  const total = rs.reduce((a, b) => a + (b.count || 0), 0);
  console.log(`${id}: total=${total} | ${rs.map(r => `${r.label}:${r.count ?? 'ERR'}@${(r.durationMs/1000).toFixed(1)}s`).join(' ')}`);
}
