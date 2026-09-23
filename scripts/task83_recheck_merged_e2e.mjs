// Task 83 recheck — merged convergence (movie + series) + playprobes per family
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
  const url = card.url || '';
  const out = { label, name: (card.name || '').slice(0, 60) };
  try {
    if (/^magnet:/i.test(url)) { out.verdict = 'MAGNET!'; return out; }
    const isM3u8 = card.type === 'application/vnd.apple.mpegurl' || /\.m3u8($|\?)/i.test(url) || /\/proxy\?/.test(url);
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...(isM3u8 ? {} : {}), ...(h || {}) }, signal: AbortSignal.timeout(25000) });
    out.status = r.status;
    const buf = Buffer.from(await r.arrayBuffer());
    out.bytes = buf.length;
    const magic = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4'
      : buf.subarray(0, 4).toString('hex') === '1a45dfa3' ? 'MKV/EBML'
        : buf[0] === 0x47 ? 'MPEG-TS'
          : buf.subarray(0, 7).toString('latin1') === '#EXTM3U' || buf.subarray(0, 7).toString('latin1') === '#EXT-X-' ? 'HLS'
            : buf.subarray(0, 15).toString('latin1').startsWith('<!DOCTYPE') ? 'HTML!' : 'unknown';
    out.magic = magic;
    out.cr = r.headers.get('content-range') || r.headers.get('content-type') || '';
    out.verdict = (magic === 'fMP4' || magic === 'MKV/EBML' || magic === 'MPEG-TS' || magic === 'HLS') && (r.status === 200 || r.status === 206) ? 'PLAYABLE' : 'NOT-PLAYABLE';
  } catch (e) { out.verdict = 'throw:' + (e?.message || e).slice(0, 50); }
  return out;
}

async function merged(label, type, rid) {
  console.log(`\n--- merged ${label} ---`);
  const rounds = [];
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    const r = await jfetch(`${BASE}/stream/${type}/${rid}.json`, {}, 150000);
    const streams = r.j?.streams || [];
    const dist = brandDist(streams);
    const cc = r.headers.get('cache-control') || '';
    const magnets = streams.filter(s => /^magnet:/i.test(s.url || '')).length;
    const html = streams.filter(s => /\.html?($|\?)/i.test(s.url || '')).length;
    const res4k = streams.filter(s => /2160|4k/i.test(s.name || '')).length;
    console.log(`  r${i}: HTTP ${r.status} in ${Date.now() - t0}ms cards=${streams.length} cc="${cc}" 4K=${res4k} magnets=${magnets} html=${html} brands=${Object.keys(dist).length}`);
    if (i === 1) console.log(`    dist: ${JSON.stringify(dist)}`);
    rounds.push({ r: i, cards: streams.length, cc, magnets, html, res4k, brands: Object.keys(dist).length, dist });
    if (/max-age=150/.test(cc)) break;
    if (i < 3) await sleep(3000);
  }
  return { label, type, rid, rounds, last: rounds[rounds.length - 1] };
}

// movie Dune2 (may be fully warm from audit) + series BBS01E1
const mv = await merged('movie Dune2', 'movie', 'tmdb:693134');
const se = await merged('series BBS01E1', 'series', 'tmdb:1396:1:1');

// playprobes: pick representative cards from the final movie response
console.log('\n--- playprobes per family (from final movie merged) ---');
const r = await jfetch(`${BASE}/stream/movie/tmdb:693134.json`, {}, 150000);
const streams = r.j?.streams || [];
const pick = (pred, n = 1) => streams.filter(pred).slice(0, n);
const picks = [
  ...pick(s => /Antarctica/.test(s.name || ''), 1),
  ...pick(s => /CineWave/.test(s.name || ''), 1),
  ...pick(s => /4KHDHub/.test(s.name || ''), 1),
  ...pick(s => /Stellar/.test(s.name || '') && !/stellarrip/i.test(s.bingeGroup || ''), 1),
  ...pick(s => /Videasy/.test(s.name || ''), 1),
  ...pick(s => /Cineby/.test(s.name || ''), 1),
  ...pick(s => /BollyFlix|UHDMovies|MoviesHunt|MoviesDrive/i.test(s.name || ''), 1),
  ...pick(s => /VidFast|VidKing|VidLink|VidSrc/i.test(s.name || ''), 1),
];
const results = [];
for (const c of picks) results.push(await playprobe('merged', c));
for (const p of results) console.log(`  ${p.verdict.padEnd(14)} ${String(p.status || '').padEnd(4)} ${String(p.magic || '').padEnd(9)} ${(p.name || '')}`);

// summary
console.log('\n===== RECHECK MERGED SUMMARY =====');
for (const m of [mv, se]) {
  const L = m.last;
  console.log(`${m.label}: converged=${/max-age=150/.test(L.cc)} cards=${L.cards} 4K=${L.res4k} magnets=${L.magnets} html=${L.html} brands=${L.brands} (rounds used: ${m.rounds.length})`);
}
const bad = results.filter(p => p.verdict !== 'PLAYABLE');
console.log(`playprobes: ${results.length - bad.length}/${results.length} PLAYABLE${bad.length ? ' — failures: ' + bad.map(p => p.name + '(' + p.verdict + ')').join(', ') : ''}`);
const fs = await import('fs');
fs.writeFileSync('/home/z/my-project/phoenix-analysis/scripts/task83_recheck_merged.json', JSON.stringify({ movie: mv, series: se, probes: results }, null, 2));
console.log('saved: scripts/task83_recheck_merged.json');
