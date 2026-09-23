// Task 82b part 3: build dating (acer cooldown marker), convergence chase (r4),
// and StellarRip window-retry with immediate playprobe on delivered cards.
const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jfetch(url, opts = {}, tmo = 120000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(tmo) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  return { status: r.status, headers: r.headers, text, j };
}
function brandDist(streams) {
  const dist = {};
  for (const s of streams) {
    const m = /PhoeniX · [^·]+ · ([^·]+?) ·/.exec(s.name || '');
    const b = m ? m[1].trim() : 'other';
    dist[b] = (dist[b] || 0) + 1;
  }
  return dist;
}
async function playprobe(label, card) {
  const h = card.behaviorHints?.proxyHeaders?.request || {};
  console.log(`  [playprobe ${label}] ${card.name} | q=${card.quality}`);
  console.log(`    url: ${card.url.slice(0, 110)}`);
  let master;
  try { master = await jfetch(card.url, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { return console.log(`    master THROW: ${e?.message || e}`); }
  if (!master.text.includes('#EXTM3U')) return console.log(`    master HTTP ${master.status} NOT m3u8: ${master.text.slice(0, 100)}`);
  const lines = master.text.split('\n');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/), bw = lines[i].match(/BANDWIDTH=(\d+)/);
      const uri = lines[i + 1];
      if (uri && !uri.startsWith('#')) variants.push({ w: res ? +res[1] : 0, h: res ? +res[2] : 0, bw: bw ? +bw[1] : 0, uri: uri.trim() });
    }
  }
  variants.sort((a, b) => b.bw - a.bw);
  console.log(`    master: 200 #EXTM3U variants=${variants.length} [${variants.slice(0, 4).map(v => v.w + 'x' + v.h).join(', ')}]`);
  if (!variants.length) return;
  const vUrl = new URL(variants[0].uri, card.url).toString();
  let v;
  try { v = await jfetch(vUrl, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { return console.log(`    variant THROW: ${e?.message || e}`); }
  const segs = v.text.split('\n').filter(l => l && !l.startsWith('#'));
  console.log(`    variant: HTTP ${v.status} segments=${segs.length}`);
  if (!segs.length) return;
  try {
    const sr = await fetch(new URL(segs[0].trim(), vUrl).toString(), { headers: { 'User-Agent': UA, ...h, Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await sr.arrayBuffer());
    const magic = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4(ftyp)' : buf[0] === 0x47 ? 'MPEG-TS' : 'unknown(' + buf.subarray(0, 6).toString('hex') + ')';
    console.log(`    segment: HTTP ${sr.status} ${buf.length}B magic=${magic}  ${magic.startsWith('fMP4') || magic === 'MPEG-TS' ? '*** PLAYABLE ***' : ''}`);
  } catch (e) { console.log(`    segment THROW: ${e?.message || e}`); }
}

// 1. build dating: acer cooldown marker (Task 81 = caea9ec)
console.log('--- acer build-marker check ---');
{
  const a = await jfetch(`${BASE}/debug/source/acermovies?type=movie&id=tmdb:27205`, {}, 30000);
  const logs = (a.j?.logs || []).join(' | ');
  const dur = a.j?.durationMs;
  const marker = /cooldown|rate-limit|fallback/i.test(logs) || (typeof dur === 'number' && dur < 2000);
  console.log(`  HTTP ${a.status} durationMs=${dur}`);
  console.log(`  logs: ${logs.slice(0, 300)}`);
  console.log(`  Task-81 cooldown circuit: ${marker ? 'PRESENT (build >= caea9ec)' : 'not observed'}`);
}

// 2. merged r4 — convergence watch
console.log('\n--- merged Dune2 r4 (convergence watch) ---');
{
  const t0 = Date.now();
  const r = await jfetch(`${BASE}/stream/movie/tmdb:693134.json`);
  const streams = r.j?.streams || [];
  const dist = brandDist(streams);
  const stellar = streams.filter(s => /PhoeniX · Stellar/.test(s.name || ''));
  console.log(`  HTTP ${r.status} in ${Date.now() - t0}ms streams=${streams.length} cc="${r.headers.get('cache-control')}"`);
  console.log(`  brands(${Object.keys(dist).length}): ${JSON.stringify(dist)}`);
  console.log(`  stellar cards: ${stellar.length}`);
  for (let i = 0; i < stellar.length; i++) await playprobe(`r4-${i + 1}`, stellar[i]);
}

// 3. StellarRip window retries: isolated Dune2, spaced ~70s, playprobe any hit
console.log('\n--- stellarrip window retries (Dune2) ---');
let hit = false;
for (let attempt = 1; attempt <= 3 && !hit; attempt++) {
  if (attempt > 1) { console.log(`  (cooldown ${70}s before attempt ${attempt})`); await sleep(70000); }
  const t0 = Date.now();
  const st = await jfetch(`${BASE}/debug/source/stellarrip?type=movie&id=tmdb:693134`);
  const cards = st.j?.streams || [];
  console.log(`  attempt ${attempt}: HTTP ${st.status} in ${Date.now() - t0}ms cards=${cards.length}`);
  if (st.j?.logs?.length) console.log(`    logs: ${st.j.logs.slice(0, 10).join(' | ').slice(0, 250)}`);
  if (cards.length) {
    hit = true;
    for (let i = 0; i < Math.min(cards.length, 2); i++) await playprobe(`iso-${attempt}-${i + 1}`, cards[i]);
  }
}
console.log(hit ? '\nRESULT: StellarRip DELIVERED + PLAYPROBED' : '\nRESULT: StellarRip dark in all 3 windows this round (gating class)');
