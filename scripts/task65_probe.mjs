// Task 65: production probe for user-named zero-stream sources
// desiflix, persianstremio, movieshuntv2, kmmovies, cinehdplus, stellarrip,
// framextv, hindmovie/hindmoviez, movielinkbd + anime matrix
const BASE = 'https://ignatiusphoenix.onrender.com';
const HDR = { 'x-request-id': 't65-probe' };

const NAMED = ['desiflix','persianstremio','movieshuntv2','kmmovies','cinehdplus','stellarrip','framextv','hindmovie','hindmoviez','movielinkbd'];
const ANIME = ['animekai','animeworldindia','anineko','animezey','itachi','anichan','nikastream','anidoor','allwish','animegg','hianime','anikototv','reanime','anibd','anikage','animeflix','animesdigital','anikoto','2dhive','animesuge'];

const PROBES = [
  { label: 'movie', qs: 'type=movie&id=tmdb:27205' },          // Inception
  { label: 'series', qs: 'type=series&id=tmdb:1399:1:1' },     // GoT S1E1
  { label: 'anime', qs: 'type=series&id=tmdb:95479:1:1' },     // JJK S1E1
];

async function probe(sourceId, p) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/debug/source/${sourceId}?${p.qs}`, { headers: HDR, signal: AbortSignal.timeout(90000) });
    const j = await r.json().catch(() => null);
    const streams = Array.isArray(j?.results) ? j.results : [];
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const quals = streams.slice(0, 3).map(s => (s.meta?.title || '').slice(0, 60));
    const logs = (j?.logs || []).slice(-4);
    return { sourceId, probe: p.label, n: streams.length, dur, err: j?.error || (j?.timedOut ? 'TIMEOUT' : null), sample: quals, logs };
  } catch (e) {
    return { sourceId, probe: p.label, n: -1, dur: ((Date.now() - t0)/1000).toFixed(1), err: String(e).slice(0, 80), sample: [] };
  }
}

const which = process.argv[2] === 'anime' ? ANIME : NAMED;
const jobs = [];
for (const s of which) for (const p of PROBES) jobs.push({ s, p });

// run with small concurrency to avoid melting the free instance
const results = [];
const CONC = 4;
let idx = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (idx < jobs.length) {
    const my = idx++;
    results.push(await probe(jobs[my].s, jobs[my].p));
  }
}));

results.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.probe.localeCompare(b.probe));
for (const r of results) {
  console.log(`${r.sourceId.padEnd(18)} ${r.probe.padEnd(7)} n=${String(r.n).padStart(4)} ${r.dur + 's'} ${r.err ? 'ERR:' + r.err : ''}`);
  for (const q of r.sample) console.log('    ' + q.replace(/\n/g, ' '));
  if (r.n === 0 && r.logs?.length) console.log('    logs: ' + r.logs.join(' || ').replace(/\n/g, ' ').slice(0, 300));
}
const zero = new Set();
for (const r of results) if (r.n <= 0) zero.add(r.sourceId);
console.log('\nZERO/ERR sources:', [...zero].join(', ') || 'NONE');
console.log('healthy:', which.filter(w => !zero.has(w)).join(', '));
