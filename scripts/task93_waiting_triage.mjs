// Task 93: triage the /status non-delivering sources (13 waiting + 1 issue).
// Probes each via prod /debug/source (live, bypasses source cache) and prints
// count + tail log line so fixable vs honest-class zeros can be separated.
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';
const ID = process.argv[2] || 'tmdb:27205'; // Inception
const TYPE = process.argv[3] || 'movie';

const SOURCES = process.argv[4]
  ? process.argv[4].split(',')
  : ['desiflix', 'movieblast', 'raflix', 'vegamovies2', 'moviesdrivev2', 'nowhdtime', 'zxcstream', 'netlio', 'pantyflix', 'animeflix', 'acermovies', 'kmmovies', 'cinefreak', 'animezey'];

async function probe(src) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${PROD}/debug/source/${src}?type=${TYPE}&id=${ID}`, { signal: AbortSignal.timeout(50000) });
    const d = await r.json();
    const logs = d.logs || [];
    return {
      src, ms: Date.now() - t0,
      count: d.count ?? (d.timedOut ? 'TIMEOUT' : '?'),
      err: d.error || '',
      tail: logs.slice(-1)[0] || '(no logs)',
    };
  } catch (e) {
    return { src, ms: Date.now() - t0, count: 'ERR', err: e?.message || String(e), tail: '' };
  }
}

// modest concurrency to avoid hammering
const out = [];
const queue = [...SOURCES];
const workers = Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const s = queue.shift();
    const r = await probe(s);
    out.push(r);
    console.log(`[${r.src}] ${r.count} (${r.ms}ms) ${r.err ? 'ERR=' + r.err.slice(0, 60) : ''} | ${String(r.tail).slice(0, 110)}`);
  }
});
await Promise.all(workers);
console.log('---');
for (const r of out) console.log(`${r.src}\t${r.count}`);
