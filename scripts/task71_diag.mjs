// Task 71: diagnose merged-path per-source outcomes + zero-source logs
const BASE = 'https://ignatiusphoenix.onrender.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function jget(path, timeoutMs = 90000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { signal: ac.signal });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (e) { return { status: 0, error: e?.message }; }
  finally { clearTimeout(t); }
}

console.log('=== /debug/stream Dune (merged-path per-source view) ===');
const ds = await jget('/debug/stream?type=movie&id=tmdb:693134');
if (ds.json) {
  const per = ds.json.perSource || ds.json.sources || ds.json.perSourceStats || null;
  console.log('keys:', Object.keys(ds.json));
  if (per) {
    for (const [id, st] of Object.entries(per)) {
      const line = typeof st === 'object' ? JSON.stringify(st).slice(0, 200) : String(st);
      console.log(`${id}: ${line}`);
    }
  } else {
    console.log(JSON.stringify(ds.json).slice(0, 3000));
  }
} else console.log('HTTP', ds.status, ds.error || '');

const anomalies = [
  ['atlantic', 'movie', 'tmdb:693134'],
  ['cineby', 'movie', 'tmdb:693134'],
  ['moviebox', 'movie', 'tmdb:693134'],
  ['zxcstream', 'movie', 'tmdb:693134'],
  ['hindmoviez', 'movie', 'tmdb:693134'],
  ['netlio', 'movie', 'tmdb:693134'],
  ['rivestream', 'movie', 'tmdb:693134'],
];
for (const [id, type, rid] of anomalies) {
  await sleep(500);
  const r = await jget(`/debug/source/${id}?type=${type}&id=${rid}`, 60000);
  const j = r.json;
  console.log(`\n=== ${id} (${type}) count=${j?.count} ${j?.durationMs}ms err=${j?.error || '-'} ===`);
  (j?.logs || []).slice(0, 14).forEach(l => console.log('  | ' + l.slice(0, 160)));
}
console.log('\nDONE');
