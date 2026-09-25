// Task 88b: follow-ups — (1) egress IP via rawfetch with raw debugging;
// (2) merged title-shape inspection (brand regex all "?" artifact);
// (3) animezey confirmation probe on Frieren (recovery is a headline finding).
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';

// ---- 1. egress IP (debug raw) ----
console.log('===== EGRESS IP =====');
for (const svc of ['https://api.ipify.org?format=json', 'https://iph.hetzner.com/json', 'https://ipwho.is/']) {
  try {
    const u = `${PROD}/debug/rawfetch?url=${encodeURIComponent(svc)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    console.log(`svc=${svc}`);
    console.log('  raw keys:', Object.keys(j).join(','), '| status:', j.status);
    const body = typeof j.body === 'string' ? j.body : JSON.stringify(j.data ?? j.body ?? '').slice(0, 300);
    console.log('  body:', String(body).slice(0, 200));
    try { const p = JSON.parse(body); if (p.ip) { console.log('  >>> EGRESS IP:', p.ip); break; } } catch {}
  } catch (e) { console.log(`  ${svc} failed: ${e.message}`); }
}

// ---- 2. merged title shape ----
console.log('\n===== MERGED TITLE SHAPE =====');
try {
  const r = await fetch(`${PROD}/stream/movie/tmdb:27205.json`, { signal: AbortSignal.timeout(90000) });
  const j = await r.json().catch(() => ({}));
  const streams = j.streams || [];
  console.log('count:', streams.length, '| cc:', r.headers.get('cache-control'));
  for (const s of streams.slice(0, 4)) {
    console.log('  title:', JSON.stringify((s.title || '').slice(0, 110)));
  }
  const noPhx = streams.filter(s => !/PhoeniX/.test(s.title || '')).length;
  console.log('titles lacking "PhoeniX":', noPhx, '/', streams.length);
  const brands = {};
  for (const s of streams) {
    const m = /PhoeniX\s*·\s*([^·]*)·([^·]*)·/.exec(s.title || '');
    const b = m ? m[1].trim() : (/(PhoeniX)/.test(s.title || '') ? 'NOMATCH-BUT-PHOENIX' : 'NOPHOENIX');
    brands[b] = (brands[b] || 0) + 1;
  }
  console.log('brands:', JSON.stringify(Object.fromEntries(Object.entries(brands).sort((a, b) => b[1] - a[1]))));
} catch (e) { console.log('merged failed:', e.message); }

// ---- 3. animezey confirmation ----
console.log('\n===== ANIMEZEY CONFIRMATION =====');
for (const [rid, label] of [['tmdb:209867:2:1', 'Frieren-S2E1'], ['tmdb:95479:1:1', 'JJK-S1E1-again']]) {
  try {
    const t0 = Date.now();
    const r = await fetch(`${PROD}/debug/source/animezey?type=anime&id=${encodeURIComponent(rid)}`, { signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    const results = j.results || j.streams || [];
    console.log(`animezey/${label}: count=${results.length} ms=${Date.now() - t0}`);
    for (const s of results.slice(0, 2)) console.log('   ->', (s.title || s.name || '').slice(0, 90), '| url:', String(s.url || '').slice(0, 70));
  } catch (e) { console.log(`animezey/${label}: ERROR ${e.message}`); }
  await new Promise(res => setTimeout(res, 1500));
}
