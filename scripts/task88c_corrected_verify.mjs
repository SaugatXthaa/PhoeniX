// Task 88c: corrected verification — egress IP via rawfetch `head` field;
// merged brand scan on stream .name (buildName carries "🐦‍🔥 PhoeniX · ...", .title carries release name).
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';

// ---- 1. egress IP ----
console.log('===== EGRESS IP =====');
let ip = null;
for (const svc of ['https://api.ipify.org?format=json', 'https://ipwho.is/']) {
  try {
    const u = `${PROD}/debug/rawfetch?url=${encodeURIComponent(svc)}`;
    const j = await fetch(u, { signal: AbortSignal.timeout(30000) }).then(r => r.json());
    const p = JSON.parse(j.head); // tiny JSON echo fits in the 300-char head
    if (p.ip) { ip = p.ip; break; }
  } catch (e) { console.log(`  ${svc}: ${e.message}`); }
}
console.log('EGRESS IP:', ip, '| Task 83/87 baseline: 74.220.48.71 |', ip === '74.220.48.71' ? 'NO ROTATION' : '*** ROTATION DETECTED ***');

// ---- 2. merged rounds: cc + name-brand scan + leak scan ----
console.log('\n===== MERGED ROUNDS (Inception, movie) =====');
for (let round = 1; round <= 3; round++) {
  try {
    const t0 = Date.now();
    const r = await fetch(`${PROD}/stream/movie/tmdb:27205.json`, { signal: AbortSignal.timeout(90000) });
    const j = await r.json().catch(() => ({}));
    const streams = j.streams || [];
    const brands = {};
    for (const s of streams) {
      const m = /PhoeniX\s*·([^·]*)·([^·]*)·/.exec(s.name || '');
      const b = m ? m[1].trim() : (/PhoeniX/.test(s.name || '') ? 'PHX-NOMATCH' : 'NOBRAND');
      brands[b] = (brands[b] || 0) + 1;
    }
    const magnets = streams.filter(s => /^magnet:/i.test(s.url || '')).length;
    const html = streams.filter(s => /^https?:\/\/[^\/]*\.(html?|php)([?#]|$)/i.test(s.url || '')).length;
    const k4 = streams.filter(s => /4K/.test(s.name || '')).length;
    console.log(`r${round}: count=${streams.length} cc="${r.headers.get('cache-control')}" ms=${Date.now() - t0} 4K=${k4} magnets=${magnets} html=${html}`);
    console.log('   brands:', JSON.stringify(Object.fromEntries(Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 14))));
    if (round === 1) {
      const s0 = streams[0] || {};
      console.log('   sample name:', JSON.stringify((s0.name || '').slice(0, 90)));
    }
  } catch (e) { console.log(`r${round} failed: ${e.message}`); }
  await new Promise(res => setTimeout(res, 2000));
}
