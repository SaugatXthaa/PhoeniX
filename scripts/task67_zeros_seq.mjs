// Task 67: sequential zero-chase for the 5 anime zeros — concurrency 1 and
// unique x-request-id per probe so /debug/source's GLOBAL console capture
// cannot cross-contaminate logs (found in task67_anime_ab round 1).
const MINE = 'https://ignatiusphoenix.onrender.com';
const TITLE = 'type=series&id=tmdb:95479:1:1'; // JJK S1E1
const ZERO = process.argv.slice(2).length ? process.argv.slice(2) : ['animegg', 'animeflix', 'animeworldindia', 'anineko', 'animotvslash'];

for (const s of ZERO) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${MINE}/debug/source/${s}?${TITLE}`, {
      headers: { 'x-request-id': `t67-seq-${s}-${Date.now()}` },
      signal: AbortSignal.timeout(100000),
    });
    const j = await r.json().catch(() => null);
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== ${s}  n=${j?.count ?? j?.results?.length ?? -1}  ${dur}s  err=${j?.error || (j?.timedOut ? 'TIMEOUT' : '-')}`);
    for (const l of (j?.logs || []).slice(-8)) console.log('  ' + l.replace(/\n/g, ' ').slice(0, 200));
  } catch (e) {
    console.log(`\n=== ${s}  FETCH-ERR ${String(e).slice(0, 90)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
