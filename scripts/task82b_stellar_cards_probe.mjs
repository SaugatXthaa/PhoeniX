// Task 82b part 2: playprobe the Stellar cards that merged Dune2 delivered,
// diagnose antarctica=0, and chase the converged cache marker (max-age=150).
const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

// 1. merged warm → extract Stellar cards
console.log('--- merged Dune2 warm r3 ---');
const t0 = Date.now();
const r = await jfetch(`${BASE}/stream/movie/tmdb:693134.json`);
const streams = r.j?.streams || [];
const dist = brandDist(streams);
console.log(`HTTP ${r.status} in ${Date.now() - t0}ms streams=${streams.length} cc="${r.headers.get('cache-control')}"`);
console.log('brands:', JSON.stringify(dist));
const stellarCards = streams.filter(s => /PhoeniX · Stellar/.test(s.name || ''));
console.log(`Stellar cards: ${stellarCards.length}`);
for (const c of stellarCards) {
  console.log(`  - ${c.name} | q=${c.quality} | ${c.url?.slice(0, 100)}`);
}

// 2. playprobe each Stellar card (master → variant → segment magic)
async function playprobe(label, card) {
  console.log(`\n--- playprobe ${label} ---`);
  const h = card.behaviorHints?.proxyHeaders?.request || {};
  console.log(`  url: ${card.url.slice(0, 110)}`);
  console.log(`  hdrs: Referer=${(h.Referer || '').slice(0, 70)} Origin=${h.Origin || '-'}`);
  let master;
  try { master = await jfetch(card.url, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { return console.log(`  master THROW: ${e?.message || e}`); }
  console.log(`  master: HTTP ${master.status} ct=${master.headers.get('content-type')} len=${master.text.length}`);
  if (!master.text.includes('#EXTM3U')) return console.log(`  master body head: ${master.text.slice(0, 120)}`);
  const lines = master.text.split('\n');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
      const bw = lines[i].match(/BANDWIDTH=(\d+)/);
      const uri = lines[i + 1];
      if (uri && !uri.startsWith('#')) variants.push({ w: res ? +res[1] : 0, h: res ? +res[2] : 0, bw: bw ? +bw[1] : 0, uri: uri.trim() });
    }
  }
  variants.sort((a, b) => b.bw - a.bw);
  console.log(`  variants: ${variants.length} [${variants.slice(0, 6).map(v => `${v.w}x${v.h}`).join(', ')}]`);
  if (!variants.length) return;
  const best = variants[0];
  const vUrl = new URL(best.uri, card.url).toString();
  let v;
  try { v = await jfetch(vUrl, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { return console.log(`  variant THROW: ${e?.message || e}`); }
  const segs = v.text.split('\n').filter(l => l && !l.startsWith('#'));
  console.log(`  variant: HTTP ${v.status}, ${segs.length} segments, first=${(segs[0] || '').slice(0, 80)}`);
  if (!segs.length) return;
  const segUrl = new URL(segs[0].trim(), vUrl).toString();
  try {
    const sr = await fetch(segUrl, { headers: { 'User-Agent': UA, ...h, Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await sr.arrayBuffer());
    const magic = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4(ftyp)'
      : buf.subarray(0, 4).toString('hex') === '1a45dfa3' ? 'MKV/EBML'
        : buf[0] === 0x47 ? 'MPEG-TS' : 'unknown(' + buf.subarray(0, 8).toString('hex') + ')';
    console.log(`  segment: HTTP ${sr.status} ${buf.length}B magic=${magic} cr=${sr.headers.get('content-range') || '-'}`);
  } catch (e) { console.log(`  segment THROW: ${e?.message || e}`); }
}
for (let i = 0; i < stellarCards.length; i++) await playprobe(`stellar#${i + 1}`, stellarCards[i]);

// 3. antarctica diagnosis
console.log('\n--- isolated antarctica (movie tmdb:693134) ---');
const t1 = Date.now();
const ant = await jfetch(`${BASE}/debug/source/antarctica?type=movie&id=tmdb:693134`);
const antStreams = ant.j?.streams || [];
console.log(`HTTP ${ant.status} in ${Date.now() - t1}ms streams=${antStreams.length} reported=${ant.j?.durationMs}ms`);
if (ant.j?.error) console.log('error:', ant.j.error);
if (ant.j?.logs?.length) console.log('logs:\n  ' + ant.j.logs.slice(0, 15).join('\n  '));
if (antStreams[0]) console.log('sample card:', antStreams[0].name, '|', (antStreams[0].url || '').slice(0, 90));

// 4. isolated stellarrip on Dune2 (the title that works) — capture real delivery logs
console.log('\n--- isolated stellarrip (movie tmdb:693134) ---');
const t2 = Date.now();
const st = await jfetch(`${BASE}/debug/source/stellarrip?type=movie&id=tmdb:693134`);
const stStreams = st.j?.streams || [];
console.log(`HTTP ${st.status} in ${Date.now() - t2}ms streams=${stStreams.length} reported=${st.j?.durationMs}ms`);
if (st.j?.logs?.length) console.log('logs:\n  ' + st.j.logs.slice(0, 25).join('\n  '));
for (const c of stStreams) console.log(`  card: ${c.name} | q=${c.quality} | ${(c.url || '').slice(0, 90)}`);
if (stStreams[0]) await playprobe('stellar-isolated-top', stStreams[0]);
