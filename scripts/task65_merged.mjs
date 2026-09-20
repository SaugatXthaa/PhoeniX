// Task 65: merged /stream health + cache-buster single-source recheck
const BASE = 'https://ignatiusphoenix.onrender.com';
const RID = 't65-' + Math.random().toString(36).slice(2, 8);

async function merged(type, id) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { headers: { 'x-request-id': RID }, signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => null);
  const streams = j?.streams || [];
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  const srcs = {};
  let html = 0;
  for (const s of streams) {
    const m = (s.name || '').split('\n')[0];
    srcs[m] = (srcs[m] || 0) + 1;
    if (/\.html?(?:[?#]|$)/i.test(s.url || '')) html++;
  }
  console.log(`[${type} ${id}] ${streams.length} cards from ${Object.keys(srcs).length} sources in ${dur}s, html=${html}`);
  console.log('  sources:', Object.entries(srcs).map(([k, v]) => `${k}(${v})`).join(' '));
}

await merged('movie', 'tt1375666');      // Inception
await merged('series', 'tt0944947:1:1'); // GoT S1E1

// cache-buster: same debug probe twice with fresh request ids
for (const round of [1, 2]) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/debug/source/itachi?type=series&id=tmdb:95479:1:1&_cb=${round}-${Date.now()}`, { headers: { 'x-request-id': RID + '-cb' + round }, signal: AbortSignal.timeout(90000) });
  const j = await r.json().catch(() => null);
  const n = Array.isArray(j?.streams) ? j.streams.length : (Array.isArray(j) ? j.length : 0);
  console.log(`itachi anime round ${round}: n=${n} in ${((Date.now() - t0) / 1000).toFixed(1)}s err=${j?.error || 'none'}`);
}
