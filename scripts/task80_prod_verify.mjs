// Task 80 — production E2E verification of the live f2bfe77 deploy.
// Verifies: cinewave + antarctica cards in merged rounds, converged
// cache-control marker (max-age=150), 4K, zero magnets/html, series parity,
// and real playability probes on cinewave + antarctica cards.
//
// Usage: node scripts/task80_prod_verify.mjs [baseUrl]

const BASE = process.argv[2] || 'https://ignatiusphoenix.onrender.com';
const TMO = 120000;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

function brandDist(streams) {
  const dist = {};
  for (const s of streams) {
    const m = /PhoeniX · [^·]+ · ([^·]+?) ·/.exec(s.name || '');
    const b = m ? m[1].trim() : 'other';
    dist[b] = (dist[b] || 0) + 1;
  }
  return dist;
}

async function merged(type, id, label) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { signal: AbortSignal.timeout(TMO) });
  const cc = r.headers.get('cache-control') || '';
  const j = await r.json();
  const streams = j.streams || [];
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const dist = brandDist(streams);
  const fourK = streams.filter(s => /· 4K/.test(s.name || '')).length;
  const html = streams.filter(s => /\.html?($|\?)/i.test(s.url || '')).length;
  const magnets = streams.filter(s => /^magnet:/i.test(s.url || '')).length;
  const cw = streams.filter(s => /CineWave/i.test(s.name || ''));
  const ant = streams.filter(s => /Antarctica/i.test(s.name || ''));
  console.log(`[${label}] total=${streams.length} @${dt}s | cc="${cc}" | 4K=${fourK} | html=${html} | magnets=${magnets} | CineWave=${cw.length} | Antarctica=${ant.length}`);
  console.log(`  brands: ${JSON.stringify(dist)}`);
  return { streams, cc, dist, fourK, html, magnets, cw, ant };
}

async function sourceProbe(id, type, tmdb) {
  const r = await fetch(`${BASE}/debug/source/${id}?type=${type}&id=tmdb:${tmdb}`, { signal: AbortSignal.timeout(TMO) });
  const j = await r.json();
  return j;
}

async function playprobe(url, label) {
  // ranged GET exactly like a player; report status + content-type + magic bytes
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', range: 'bytes=0-2047' }, signal: AbortSignal.timeout(20000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || '';
  const cr = r.headers.get('content-range') || '';
  let magic = '?';
  if (buf.slice(4, 8).toString() === 'ftyp') magic = 'MP4';
  else if (buf[0] === 0x1a && buf[1] === 0x45) magic = 'MKV/EBML';
  else if (buf[0] === 0x47 && buf[188] === 0x47) magic = 'MPEG-TS';
  else if (buf.slice(0, 7).toString().startsWith('#EXTM3U')) magic = 'M3U8';
  const ok = (r.status === 206 || r.status === 200) && magic !== '?';
  console.log(`  ${label}: HTTP ${r.status} | ct=${ct} | range=${cr} | magic=${magic}`);
  return ok;
}

console.log(`=== PRODUCTION E2E @ ${BASE} ===`);

// 1. isolated source probes
const cwSrc = await sourceProbe('cinewave', 'movie', 693134).catch(e => ({ error: e.message }));
console.log(`\n[isolated] cinewave Dune2: count=${cwSrc.count ?? cwSrc.error}`);
check('cinewave isolated probe delivers', (cwSrc.count || 0) >= 20, `count=${cwSrc.count}`);

const antSrc = await sourceProbe('antarctica', 'movie', 693134).catch(e => ({ error: e.message }));
console.log(`[isolated] antarctica Dune2: count=${antSrc.count ?? antSrc.error}`);
check('antarctica isolated probe delivers 50', antSrc.count === 50, `count=${antSrc.count}`);

// 2. merged movie rounds (cold -> warm)
const r1 = await merged('movie', 'tmdb:693134', 'movie Dune2 r1(cold)');
check('Dune2 r1: cinewave cards in merged', r1.cw.length >= 1, `cinewave=${r1.cw.length}`);
check('Dune2 r1: antarctica cards in merged', r1.ant.length >= 40, `antarctica=${r1.ant.length}`);
check('Dune2 r1: zero magnets', r1.magnets === 0);
check('Dune2 r1: zero html URLs', r1.html === 0);

const r2 = await merged('movie', 'tmdb:693134', 'movie Dune2 r2(warm)');
check('Dune2 r2: converged cache-control = max-age=150 (Task 76 marker)', /max-age=150/.test(r2.cc), `cc="${r2.cc}"`);
check('Dune2 r2: cinewave cards still present', r2.cw.length >= 1, `cinewave=${r2.cw.length}`);
check('Dune2 r2: antarctica still present', r2.ant.length >= 40, `antarctica=${r2.ant.length}`);
check('Dune2 r2: warm convergence total >= r1', r2.streams.length >= r1.streams.length, `${r2.streams.length} vs ${r1.streams.length}`);
check('Dune2 r2: 4K present', r2.fourK >= 10, `4K=${r2.fourK}`);

// 3. series parity
const s1 = await merged('series', 'tmdb:1396:1:1', 'series BBS01E1 r1');
check('BBS01E1: healthy deliver (>=40 cards)', s1.streams.length >= 40, `total=${s1.streams.length}`);
check('BBS01E1: cinewave cards present', s1.cw.length >= 1, `cinewave=${s1.cw.length}`);
check('BBS01E1: antarctica cards present', s1.ant.length >= 40, `antarctica=${s1.ant.length}`);
check('BBS01E1: zero magnets / zero html', s1.magnets === 0 && s1.html === 0);

// 4. playability — a cinewave card and an antarctica card from the live merged response
const cwCard = (r2.cw.find(s => /pixeldrain/.test(s.url || '')) || r2.cw[0]);
if (cwCard) {
  const ok = await playprobe(cwCard.url, 'cinewave card playprobe');
  check('cinewave card is REAL playable media', ok);
} else check('cinewave card playprobe', false, 'no card to probe');

const antCard = r2.ant[0];
if (antCard) {
  const ok = await playprobe(antCard.url, 'antarctica card playprobe');
  check('antarctica card is REAL playable media', ok);
}

console.log(`\n=== RESULT: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
