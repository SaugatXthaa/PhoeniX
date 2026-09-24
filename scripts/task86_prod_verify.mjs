// Wait for Render redeploy (bootAt newer than the push), then verify the fixed sources on prod.
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';
const CUTOFF = '2026-09-24T16:40'; // push was ~16:39Z

let boot = '';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(PROD + '/health', { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    boot = j.bootAt || '';
    if (boot > CUTOFF) { console.log(`NEW BOOT: ${boot} (sources=${j.sources?.length})`); break; }
    console.log(`wait ${i}: old boot ${boot}`);
  } catch (e) { console.log(`wait ${i}: ${e.message.slice(0, 40)}`); }
  await new Promise(r => setTimeout(r, 30000));
}
if (boot <= CUTOFF) { console.log('TIMEOUT waiting for new boot'); process.exit(1); }

// warm the instance then verify
const PROBES = [
  ['atlantic',    'movie',  'tmdb:693134', 'Dune2'],
  ['atlantic',    'series', 'tmdb:1396:1:1', 'BB'],
  ['zxcstream',   'movie',  'tmdb:27205', 'Inception'],
  ['zxcstream',   'series', 'tmdb:1396:1:1', 'BB'],
  ['meinecloud',  'movie',  'tmdb:27205', 'Inception'],
  ['cinehdplus',  'series', 'tmdb:1396:1:1', 'BB'],
  ['cinehdplus',  'series', 'tmdb:93405:1:1', 'Squid'],
  ['verhdlink',   'movie',  'tmdb:693134', 'Dune2'],
  ['verhdlink',   'movie',  'tmdb:27205', 'Inception'],
];

for (const [id, type, rid, label] of PROBES) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${PROD}/debug/source/${id}?type=${type}&id=${encodeURIComponent(rid)}`, { signal: AbortSignal.timeout(80000) });
    const j = await r.json();
    const count = j.count ?? 'ERR';
    console.log(`[${count > 0 ? 'HIT ' : 'ZERO'}] ${id} ${type}/${label} count=${count} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (j.results && j.results.length) j.results.slice(0, 2).forEach(s => console.log('     ', (s.meta?.title || '').slice(0, 60), '|', String(s.url).slice(0, 75)));
    if (!count) (j.logs || []).slice(-4).forEach(l => console.log('     log:', l.slice(0, 110)));
  } catch (e) { console.log(`[FAIL] ${id}/${label}: ${e.message.slice(0, 70)}`); }
}
console.log('prod verification done');
