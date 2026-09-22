// Task 82 — checks against an ALREADY-RUNNING sandbox on 127.0.0.1:7082.
const BASE = 'http://127.0.0.1:7082';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

async function dbgSource(sourceId, tmdb, type = 'movie') {
  const r = await fetch(`${BASE}/debug/source/${sourceId}?type=${type}&id=tmdb:${tmdb}`, { signal: AbortSignal.timeout(90000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function mergedRound(type, id) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { signal: AbortSignal.timeout(120000) });
  const cc = r.headers.get('cache-control') || '';
  const j = await r.json().catch(() => ({ streams: [] }));
  return { cc, streams: j.streams || [], dt: ((Date.now() - t0) / 1000).toFixed(1) };
}

(async () => {
  // 1. registry
  {
    const r = await fetch(BASE + '/debug/source/__nonexistent__');
    const j = await r.json().catch(() => ({}));
    const avail = j.error || '';
    check('registry: stellarrip registered', avail.includes('stellarrip'));
    check('registry: antarctica present', avail.includes('antarctica'));
  }

  // 2. stellarrip chain progression
  {
    const { body } = await dbgSource('stellarrip', 693134, 'movie');
    const logs = (body?.logs || []).map(l => String(l)).join(' | ');
    const tokensOk = logs.includes('Request token acquired') && logs.includes('Stream token acquired');
    const chainTimeout = /aborted due to timeout/.test(logs);
    const n = (body?.streams || []).length;
    check('stellarrip Dune2: chain reaches sweep (tokens acquired)', tokensOk, `cards=${n}`);
    check('stellarrip Dune2: no chain-killing timeout', !chainTimeout, chainTimeout ? 'TIMEOUT IN LOGS' : 'clean');
    if (n > 0) {
      const urls = (body.streams || []).map(s => s.url || '');
      check('stellarrip Dune2: all URLs https', urls.every(u => u.startsWith('https://')), `${urls.length} urls`);
    }
  }

  // 3. merged rounds
  {
    const r1 = await mergedRound('movie', 'tmdb:693134');
    const html = r1.streams.filter(s => /\.html?($|\?)/i.test(s.url || '')).length;
    const magnets = r1.streams.filter(s => /^magnet:/i.test(s.url || '')).length;
    check('merged Dune2 r1: healthy card count', r1.streams.length >= 60, `total=${r1.streams.length} @${r1.dt}s`);
    check('merged Dune2 r1: 0 magnets / 0 html', magnets === 0 && html === 0, `m=${magnets} h=${html}`);
    const r2 = await mergedRound('movie', 'tmdb:693134');
    check('merged Dune2 r2 warm: converged', r2.streams.length >= r1.streams.length, `r2=${r2.streams.length} @${r2.dt}s`);
    check('merged Dune2 r2: cc max-age=150', /max-age=150/.test(r2.cc), r2.cc);
  }
})().catch(e => { check('harness', false, e.message); }).finally(() => {
  console.log(`\n=== RESULT: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ===`);
  process.exit(failures > 0 ? 1 : 0);
});
