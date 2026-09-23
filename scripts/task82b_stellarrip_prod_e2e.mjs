// Task 82b: StellarRip end-to-end verification on the NEW production deployment
// (ignatiusphoenix-5zrn.onrender.com) at commit 8b14b15 (Task 82 timing rework).
//
// Protocol:
//   1. Isolated /debug/source/stellarrip — movie (Inception tmdb:27205) + series
//      (Breaking Bad S1E1 tmdb:1396:1:1). The debug endpoint runs the REAL
//      provider (full cookie chain, PoW, paced sweep) inside production.
//   2. If cards: playprobe the top card — fetch master playlist with the card's
//      proxyHeaders (Referer/Origin/UA) → #EXTM3U + variant ladder → best
//      variant → segment list → first segment magic bytes (fMP4/TS).
//   3. Merged /stream regression — Dune2 tmdb:693134 cold + warm rounds:
//      brand dist (Stellar*), cache-control marker (expect max-age=150),
//      antarctica/cinewave sanity, 0 magnets / 0 html invariants.

const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMO = 120000;
const PASS = [], FAIL = [];
const ok = (name, cond, detail) => { (cond ? PASS : FAIL).push(`${name} :: ${detail}`); console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };

async function jfetch(url, opts = {}, tmo = TMO) {
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

// ---- isolated /debug/source -------------------------------------------------
async function isolated(label, type, id) {
  console.log(`\n--- isolated ${label} (${type} ${id}) ---`);
  const t0 = Date.now();
  const r = await jfetch(`${BASE}/debug/source/stellarrip?type=${type}&id=${encodeURIComponent(id)}`);
  const ms = Date.now() - t0;
  const j = r.j || {};
  const streams = j.streams || [];
  console.log(`  HTTP ${r.status} in ${ms}ms; streams=${streams.length}; reported durationMs=${j.durationMs ?? '?'}`);
  if (j.logs?.length) console.log('  logs:\n    ' + j.logs.slice(0, 25).join('\n    '));
  return { streams, ms, httpOk: r.status === 200 };
}

// ---- playprobe --------------------------------------------------------------
async function playprobe(label, card) {
  console.log(`\n--- playprobe ${label} ---`);
  const url = card.url;
  const h = card.behaviorHints?.proxyHeaders?.request || {};
  console.log(`  url: ${url.slice(0, 90)}...`);
  console.log(`  headers: Referer=${(h.Referer || '').slice(0, 60)} Origin=${h.Origin || ''}`);

  // master
  let master;
  try { master = await jfetch(url, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { ok(label + ' master', false, 'fetch throw: ' + (e?.message || e)); return; }
  ok(label + ' master status', master.status === 200, `HTTP ${master.status}`);
  const isMaster = master.text.includes('#EXTM3U');
  ok(label + ' master magic', isMaster, master.text.slice(0, 60).replace(/\n/g, ' '));
  if (!isMaster) return;

  // variants
  const variants = [];
  for (const line of master.text.split('\n')) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bw = line.match(/BANDWIDTH=(\d+)/);
      const uri = master.text.split('\n')[master.text.split('\n').indexOf(line) + 1];
      if (uri && !uri.startsWith('#')) variants.push({ w: res ? +res[1] : 0, h: res ? +res[2] : 0, bw: bw ? +bw[1] : 0, uri: uri.trim() });
    }
  }
  variants.sort((a, b) => b.bw - a.bw);
  console.log(`  variants: ${variants.length} [${variants.slice(0, 5).map(v => `${v.w}x${v.h}`).join(', ')}]`);
  ok(label + ' variant ladder', variants.length > 0, `${variants.length} variants, best=${variants[0] ? variants[0].w + 'x' + variants[0].h : 'n/a'}`);

  // resolve variant uri against master url
  const best = variants[0];
  if (!best) return;
  const vUrl = new URL(best.uri, url).toString();

  // variant
  let varRes;
  try { varRes = await jfetch(vUrl, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { ok(label + ' variant', false, 'fetch throw: ' + (e?.message || e)); return; }
  ok(label + ' variant status', varRes.status === 200, `HTTP ${varRes.status}`);
  const segs = varRes.text.split('\n').filter(l => l && !l.startsWith('#'));
  const firstSeg = segs[0];
  ok(label + ' segments', segs.length > 0, `${segs.length} segment URIs; first=${(firstSeg || '').slice(0, 70)}`);
  if (!firstSeg) return;
  const segUrl = new URL(firstSeg.trim(), vUrl).toString();

  // first segment — magic bytes
  try {
    const r = await fetch(segUrl, { headers: { 'User-Agent': UA, ...h, Range: 'bytes=0-4095', Referer: h.Referer, Origin: h.Origin }, signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const magic =
      buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4 (ftyp)' :
        buf.subarray(0, 4).toString('hex') === '1a45dfa3' ? 'MKV/EBML' :
          buf[0] === 0x47 ? 'MPEG-TS' : 'unknown:' + buf.subarray(0, 8).toString('hex');
    ok(label + ' segment bytes', (r.status === 206 || r.status === 200) && magic !== 'unknown:' + buf.subarray(0, 8).toString('hex'),
      `HTTP ${r.status}, ${buf.length}B, magic=${magic}, cr=${r.headers.get('content-range') || '-'}`);
  } catch (e) {
    ok(label + ' segment bytes', false, 'fetch throw: ' + (e?.message || e));
  }
}

// ---- main -------------------------------------------------------------------
console.log('Task 82b: StellarRip E2E on NEW production deployment');
console.log(`BASE=${BASE}`);

// 1. isolated movie (Inception)
const inc = await isolated('movie Inception', 'movie', 'tmdb:27205');
ok('isolated movie HTTP', inc.httpOk && inc.streams.length >= 0, `streams=${inc.streams.length} in ${inc.ms}ms`);

// 2. isolated series (BB S1E1)
const bb = await isolated('series BBS01E1', 'series', 'tmdb:1396:1:1');
ok('isolated series HTTP', bb.httpOk && bb.streams.length >= 0, `streams=${bb.streams.length} in ${bb.ms}ms`);

// 3. playprobes (top movie card + top series card if any)
const topMovie = inc.streams[0];
if (topMovie) await playprobe('movie top card', topMovie); else console.log('\n(no movie cards to playprobe)');
const topSeries = bb.streams[0];
if (topSeries) await playprobe('series top card', topSeries); else console.log('(no series cards to playprobe)');

// 4. merged regression: Dune2 cold → warm
console.log('\n--- merged Dune2 (tmdb:693134) cold → warm ---');
let mergedRounds = [];
for (const round of ['r1-cold', 'r2-warm']) {
  const t0 = Date.now();
  const r = await jfetch(`${BASE}/stream/movie/tmdb:693134.json`);
  const ms = Date.now() - t0;
  const streams = r.j?.streams || [];
  const dist = brandDist(streams);
  const cc = r.headers.get('cache-control') || '';
  const magnets = streams.filter(s => /^magnet:/i.test(s.url || '')).length;
  const html = streams.filter(s => /\.html?($|\?)/i.test(s.url || '')).length;
  const stellar = Object.entries(dist).filter(([k]) => /stellar/i.test(k)).reduce((a, [, v]) => a + v, 0);
  const antarctica = dist['Antarctica'] || 0;
  const cinewave = Object.entries(dist).filter(([k]) => /cinewave/i.test(k)).reduce((a, [, v]) => a + v, 0);
  const res4k = streams.filter(s => /2160|4k/i.test(s.name || '') || /2160/.test(s.description || '')).length;
  console.log(`  ${round}: HTTP ${r.status} in ${ms}ms streams=${streams.length} cc="${cc}" 4K≈${res4k}`);
  console.log(`    brands: ${JSON.stringify(dist)}`);
  console.log(`    invariants: magnets=${magnets} html=${html} stellar=${stellar} antarctica=${antarctica} cinewave=${cinewave}`);
  mergedRounds.push({ round, streams: streams.length, cc, magnets, html, stellar, antarctica, cinewave });
}
const warm = mergedRounds[1];
ok('merged warm converged', warm.streams > 100, `${warm.streams} cards`);
ok('merged cc marker (Task 76 = 150)', /max-age=150/.test(warm.cc), `cc="${warm.cc}"`);
ok('merged zero magnets', warm.magnets === 0, `magnets=${warm.magnets}`);
ok('merged zero html', warm.html === 0, `html=${warm.html}`);
ok('merged antarctica sanity', warm.antarctica >= 40, `antarctica=${warm.antarctica}`);
ok('merged cinewave sanity', warm.cinewave >= 2, `cinewave=${warm.cinewave}`);
ok('merged stellarrip present', warm.stellar > 0, `stellar cards=${warm.stellar} (cold r1=${mergedRounds[0].stellar})`);

// ---- summary ----------------------------------------------------------------
console.log('\n===== E2E SUMMARY =====');
console.log(`PASS ${PASS.length} / FAIL ${FAIL.length}`);
PASS.forEach(p => console.log('  ✓ ' + p));
FAIL.forEach(f => console.log('  ✗ ' + f));

const fs = await import('fs');
fs.writeFileSync('/home/z/my-project/scripts/task82b_e2e_results.json', JSON.stringify({
  inception: { streams: inc.streams.length, ms: inc.ms, cards: inc.streams.map(s => ({ name: s.name, quality: s.quality, url: s.url?.slice(0, 120) })) },
  bbs01e1: { streams: bb.streams.length, ms: bb.ms, cards: bb.streams.map(s => ({ name: s.name, quality: s.quality, url: s.url?.slice(0, 120) })) },
  merged: mergedRounds,
  pass: PASS, fail: FAIL,
}, null, 2));
console.log('\nSaved: scripts/task82b_e2e_results.json');
