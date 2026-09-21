// Task 73: measure the "only 7-8 streams" regression on production, live
const PROD = 'https://ignatiusphoenix.onrender.com';
const jget = async (u, t = 120000) => {
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(t) });
  return { j: await r.json(), ms: Date.now() - t0 };
};

const TITLES = [
  ['movie', 'tmdb:693134', 'Dune2'],
  ['series', 'tmdb:93405:1:1', 'SquidGame S1E1'],
  ['movie', 'tmdb:155', 'The Dark Knight'],
];

console.log('=== merged rounds (r1 fresh, r2 refresh) ===');
for (const [type, id, name] of TITLES) {
  for (const round of [1, 2]) {
    try {
      const { j, ms } = await jget(`${PROD}/stream/${type}/${id}.json`);
      const s = j.streams || [];
      const fourK = s.filter(x => /· 4K/.test(x.name || '')).length;
      const html = s.filter(x => /\.html?($|\?)/i.test(x.url || '')).length;
      const subs = s.filter(x => (x.subtitles || []).length > 0).length;
      console.log(`${name} r${round}: ${s.length} cards in ${ms}ms | 4K=${fourK} html=${html} subs=${subs}/${s.length}`);
    } catch (e) { console.log(`${name} r${round}: ERR ${e.message.slice(0, 60)}`); }
  }
}

console.log('=== /debug/stream per-source (Dune2 fresh resolve) ===');
{
  const { j } = await jget(`${PROD}/debug/stream?type=movie&id=tmdb:693134`);
  const rows = j.sources || j.perSource || j;
  if (Array.isArray(rows)) {
    const ok = rows.filter(r => (r.count || 0) > 0);
    const zero = rows.filter(r => (r.count || 0) === 0);
    console.log(`delivering ${ok.length} / zero ${zero.length}`);
    ok.sort((a, b) => (b.count || 0) - (a.count || 0));
    ok.forEach(r => console.log(`  + ${r.sourceId || r.id}: ${r.count} (${r.durationMs || '?'}ms)`));
    zero.forEach(r => console.log(`  - ${r.sourceId || r.id}: 0 (${r.status || r.reason || r.error || ''})`));
  } else {
    console.log(JSON.stringify(j).slice(0, 2000));
  }
}
