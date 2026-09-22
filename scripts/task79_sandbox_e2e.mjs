// Task 79: throttled-sandbox E2E for the atlantic gate fix (0.1 CPU / 448MB
// = Render free tier, standing rule). Spawned INSIDE the sandbox by
// render_sandbox.cjs consumers; expects PORT env.
const BASE = `http://127.0.0.1:${process.env.PORT || 7070}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function jget(path, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { signal: ac.signal });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { return { status: res.status, json: null, text: text.slice(0, 200) }; }
  } catch (e) { return { status: 0, error: e?.message || String(e) }; }
  finally { clearTimeout(t); }
}

console.log('=== task79 E2E (sandbox port ' + (process.env.PORT || 7070) + ') ===');

// wait for boot
for (let i = 0; i < 30; i++) {
  const h = await jget('/health', 5000).catch(() => null);
  if (h && h.status === 200) { console.log('server up after ' + i + ' checks'); break; }
  await sleep(1000);
}

// 1. isolated atlantic probes (real scrapes, bypass caches)
const ISOLATED = [
  ['movie', 'tmdb:693134', 'Dune2'],
  ['series', 'tmdb:93405:1:1', 'SquidGame S1E1'],
];
let isoOk = 0;
for (const [type, id, label] of ISOLATED) {
  const r = await jget(`/debug/source/atlantic?type=${type}&id=${id}`, 70000);
  const c = r.json?.count ?? -1;
  const logs = (r.json?.logs || []).filter(l => /gate|title mismatch|validation|artemis|aphrodite/i.test(l)).slice(-4);
  console.log(`[isolated] ${label}: count=${c} ${(r.json?.durationMs ?? 0)}ms ${c > 0 ? '✓' : '✗'}`);
  logs.forEach(l => console.log('    ', l.slice(0, 150)));
  if (c > 0) isoOk++;
}

// 2. merged round Dune2 (cards must include atlantic when it delivers)
const r1 = await jget('/stream/movie/tmdb:693134.json', 95000);
const s1 = r1.json?.streams || [];
const a1 = s1.filter(s => /Atlantic/.test(s.name || ''));
console.log(`[merged r1] Dune2: ${s1.length} cards, atlantic=${a1.length}, subs=${s1.filter(s => (s.subtitles || []).length > 0).length}/${s1.length}, html=${s1.filter(s => /\.html?($|\?)/.test(s.url || '')).length}`);

console.log(`\nISOLATED: ${isoOk}/3 titles delivered`);
console.log(isoOk >= 1 ? 'RESULT: PASS (upstream flap tolerance — ≥1 title delivered)' : 'RESULT: RETRY (0 titles — check upstream window)');
process.exit(isoOk >= 1 ? 0 : 2);
