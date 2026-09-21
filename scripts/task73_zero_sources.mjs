// Task 73: isolated health of the sources that zeroed in merged rounds
const PROD = 'https://ignatiusphoenix.onrender.com';
const SOURCES = ['uhdmovies', 'desiflix', 'hindmoviez', 'moviesdrivev2', 'cinehdplus', 'persianstremio', 'nowhdtime', 'acermovies', 'watchseries', 'peckle'];
const jget = async (u, t = 90000) => {
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(t) });
  return { j: await r.json(), ms: Date.now() - t0 };
};
for (const src of SOURCES) {
  try {
    const { j, ms } = await jget(`${PROD}/debug/source/${src}?type=movie&id=tmdb:693134`);
    const tail = (j.logs || []).filter(l => /error|fail|timeout|Returning|Resolved|lockout/i.test(l)).slice(-2)
      .map(l => l.slice(0, 110)).join(' || ');
    console.log(`${src.padEnd(16)} count=${String(j.count).padStart(3)} in ${j.durationMs || '?'}ms ${tail ? '| ' + tail : ''}`);
  } catch (e) { console.log(`${src.padEnd(16)} ERR ${e.message.slice(0, 60)}`); }
}
