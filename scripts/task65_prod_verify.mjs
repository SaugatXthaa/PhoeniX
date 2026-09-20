// Task 65: production verification of the deployed fixes
const BASE = 'https://ignatiusphoenix.onrender.com';
const HDR = { 'x-request-id': 't65-verify' };

const PROBES = [
  // fixed sources — expecting >0 now
  ['movielinkbd', 'series', 'tmdb:1399:1:1'],
  ['movieshuntv2', 'series', 'tmdb:95479:1:1'],   // JJK
  ['movieshuntv2', 'series', 'tmdb:1399:1:1'],    // GoT
  ['desiflix', 'movie', 'tmdb:27205'],
  ['hindmoviez', 'movie', 'tmdb:27205'],
  ['cinehdplus', 'series', 'tmdb:1399:1:1'],
  ['kmmovies', 'movie', 'tmdb:27205'],
  ['framextv', 'movie', 'tmdb:27205'],
  ['persianstremio', 'movie', 'tmdb:27205'],
  // anime sanity (was healthy, must stay healthy)
  ['animekai', 'series', 'tmdb:95479:1:1'],
  ['itachi', 'series', 'tmdb:95479:1:1'],
  ['animezey', 'series', 'tmdb:95479:1:1'],
];

const CONC = 3;
let idx = 0;
const results = [];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (idx < PROBES.length) {
    const [sid, type, id] = PROBES[idx++];
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/debug/source/${sid}?type=${type}&id=${id}`, { headers: HDR, signal: AbortSignal.timeout(75000) });
      const j = await r.json();
      results.push({ sid, type, n: j.count || 0, dur: ((Date.now() - t0) / 1000).toFixed(1), err: j.error || (j.timedOut ? 'TIMEOUT' : '') });
    } catch (e) {
      results.push({ sid, type, n: -1, dur: ((Date.now() - t0) / 1000).toFixed(1), err: String(e).slice(0, 50) });
    }
  }
}));

console.log('=== production verify (deploy fafa063) ===');
let ok = 0;
for (const r of results) {
  const mark = r.n > 0 ? 'OK ' : 'ZERO';
  if (r.n > 0) ok++;
  console.log(`${mark} ${r.sid.padEnd(15)} ${r.type.padEnd(7)} n=${String(r.n).padStart(3)} ${r.dur}s ${r.err}`);
}
console.log(`\n${ok}/${results.length} sources delivering`);
