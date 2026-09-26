#!/usr/bin/env node
// Task 99 — sweep the three QHD-capable sources (stellar/vidlink2/videasyto)
// across a title batch to find live height-1440 cards for the E2E A/B.
const BASE = 'http://localhost:7100';
const SOURCES = ['vidlink2', 'videasyto', 'stellar'];
const TITLES = [
  ['movie', 'tt1630029'], ['movie', 'tt9362722'], ['movie', 'tt1517268'],
  ['movie', 'tt6710474'], ['movie', 'tt10872600'], ['movie', 'tt6791350'],
  ['movie', 'tt9114286'], ['movie', 'tt1745960'], ['movie', 'tt10648342'],
  ['movie', 'tt9603212'], ['series', 'tt0944947/1/1'], ['series', 'tt0903747/1/1'],
  ['series', 'tt10919420/2/1'], ['series', 'tt9561862/1/1'], ['series', 'tt13443470/1/1'],
  ['series', 'tt5491994/1/1'], ['series', 'tt0386676/1/1'], ['series', 'tt2442560/1/1'],
];
const hits = [];
const pool = [];
for (const src of SOURCES) {
  for (const [type, path] of TITLES) {
    pool.push((async () => {
      try {
        const r = await fetch(`${BASE}/stream/${type}/${path}.json?sources=${src}`, { signal: AbortSignal.timeout(90_000) });
        const b = await r.json().catch(() => null);
        const streams = b?.streams || [];
        const qhd = streams.filter(s => /1440p/.test(s.name || ''));
        if (qhd.length) {
          hits.push({ src, type, path, qhd: qhd.length, total: streams.length, name: qhd[0].name, title: (qhd[0].title || '').slice(0, 60) });
          console.log(`QHD HIT ${src} ${type} ${path}: ${qhd.length}/${streams.length} — ${qhd[0].name}`);
        }
      } catch {}
    })());
    // small in-flight cap
    if (pool.length >= 8) await Promise.race(pool);
    for (let i = pool.length - 1; i >= 0; i--) {
      // drop settled
      const settled = await Promise.race([pool[i].then(() => true).catch(() => true), Promise.resolve(false)]);
      if (settled) pool.splice(i, 1);
    }
  }
}
await Promise.allSettled(pool);
console.log(`\nSWEEP DONE: ${hits.length} QHD hits`);
for (const hh of hits) console.log(`  ${hh.src} ${hh.type} ${hh.path} — ${hh.qhd}/${hh.total} — ${hh.name}`);
process.exit(0);
