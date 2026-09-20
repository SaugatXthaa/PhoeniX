// Task 67: anime-source A/B — ours vs original repo deployment, same tooling.
// User: "Also do same and check for animes sources aswell."
// Method (mirrors Task 66): per-source /debug/source on BOTH deployments for
// the same anime title (JJK S1E1 = tmdb:95479:1:1), then merged /stream parity.
const MINE = 'https://ignatiusphoenix.onrender.com';
const ORIG = 'https://phoenix-hgs3.onrender.com';
const HDR = { 'x-request-id': 't67-anime-ab' };
const TITLE = { label: 'JJK S1E1', qs: 'type=series&id=tmdb:95479:1:1' };

const MINE_ANIME = ['animekai','animeworldindia','anineko','animezey','itachi','anichan','nikastream','anidoor','allwish','animegg','hianime','anikototv','reanime','anibd','anikage','animeflix','animesdigital','anikoto','2dhive','animesuge','animotvslash'];
const ORIG_ANIME = ['animekai','animeworldindia','anineko','animezey','itachi','anichan','nikastream','anidoor','allwish','animegg','hianime','anikototv','reanime','anibd','anikage','animeflix','animesdigital','anikoto','2dhive','animesuge','antova'];

async function probeSource(base, sourceId, p) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/debug/source/${sourceId}?${p.qs}`, { headers: HDR, signal: AbortSignal.timeout(100000) });
    const j = await r.json().catch(() => null);
    const streams = Array.isArray(j?.results) ? j.results : [];
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const logs = (j?.logs || []).slice(-3);
    return { base, sourceId, n: streams.length, dur, err: j?.error || (j?.timedOut ? 'TIMEOUT' : null), logs };
  } catch (e) {
    return { base, sourceId, n: -1, dur: ((Date.now() - t0) / 1000).toFixed(1), err: String(e).slice(0, 70), logs: [] };
  }
}

async function runPool(jobs, fn, conc = 4) {
  const results = [];
  let idx = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (idx < jobs.length) {
      const my = idx++;
      results.push(await fn(jobs[my]));
    }
  }));
  return results;
}

const which = process.argv[2] || 'both'; // mine | orig | both
const jobs = [];
if (which === 'mine' || which === 'both') for (const s of MINE_ANIME) jobs.push({ base: MINE, sourceId: s });
if (which === 'orig' || which === 'both') for (const s of ORIG_ANIME) jobs.push({ base: ORIG, sourceId: s });

console.log(`# ${TITLE.label} per-source probe — ${new Date().toISOString()}`);
const results = await runPool(jobs, (j) => probeSource(j.base, j.sourceId, TITLE));
const tag = { [MINE]: 'MINE', [ORIG]: 'ORIG' };
for (const r of results.sort((a, b) => (a.sourceId.localeCompare(b.sourceId)) || (a.base.localeCompare(b.base)))) {
  console.log(`${tag[r.base].padEnd(5)} ${r.sourceId.padEnd(17)} n=${String(r.n).padStart(4)} ${r.dur + 's'} ${r.err ? 'ERR:' + r.err : ''}`);
  if (r.n === 0 && r.logs.length) console.log(`      logs: ${r.logs.join(' || ').replace(/\n/g, ' ').slice(0, 260)}`);
}
