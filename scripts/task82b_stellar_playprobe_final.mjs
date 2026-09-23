// Task 82b part 4 (final): playprobe the Stellar cards from the converged
// merged response — corrected name filter (brandDist captured "Stellar" as the
// THIRD segment of "PhoeniX · <mid> · Stellar… ·", so the card-name pattern is
// /· Stellar/, not /PhoeniX · Stellar/).
const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jfetch(url, opts = {}, tmo = 120000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(tmo) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  return { status: r.status, headers: r.headers, text, j };
}

function findStellar(streams) {
  return streams.filter(s => /·\s*Stellar/.test(s.name || '') || /stellar/i.test(s.bingeGroup || ''));
}

async function playprobe(label, card) {
  const h = card.behaviorHints?.proxyHeaders?.request || {};
  console.log(`\n[playprobe ${label}] name="${card.name}"`);
  console.log(`  quality=${card.quality} type=${card.type || '-'} bingeGroup=${card.bingeGroup || '-'}`);
  console.log(`  url=${card.url?.slice(0, 120)}`);
  console.log(`  proxyHeaders: ${JSON.stringify(h)}`);
  if (!card.url) return console.log('  NO URL — cannot probe');
  let master;
  try { master = await jfetch(card.url, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { return console.log(`  master THROW: ${e?.message || e}`); }
  if (!master.text.includes('#EXTM3U')) {
    return console.log(`  master HTTP ${master.status} NOT m3u8 (ct=${master.headers.get('content-type')}): ${master.text.slice(0, 140).replace(/\n/g, ' ')}`);
  }
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
  console.log(`  master: HTTP ${master.status} #EXTM3U variants=${variants.length} [${variants.slice(0, 5).map(v => `${v.w}x${v.h}@${Math.round(v.bw / 1000)}k`).join(', ')}]`);
  if (!variants.length) return;
  const vUrl = new URL(variants[0].uri, card.url).toString();
  let v;
  try { v = await jfetch(vUrl, { headers: { 'User-Agent': UA, ...h } }, 25000); }
  catch (e) { return console.log(`  variant THROW: ${e?.message || e}`); }
  const segs = v.text.split('\n').filter(l => l && !l.startsWith('#'));
  const initSeg = v.text.split('\n').find(l => l.startsWith('#EXT-X-MAP'))?.match(/URI="([^"]+)"/)?.[1];
  console.log(`  variant: HTTP ${v.status} segments=${segs.length}${initSeg ? ` initMap=${initSeg.slice(0, 60)}` : ''}`);
  const firstMedia = initSeg ? new URL(initSeg, vUrl).toString() : (segs[0] ? new URL(segs[0].trim(), vUrl).toString() : null);
  if (!firstMedia) return;
  try {
    const sr = await fetch(firstMedia, { headers: { 'User-Agent': UA, ...h, Range: 'bytes=0-8191' }, signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await sr.arrayBuffer());
    const magic = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4(ftyp)'
      : buf.subarray(0, 4).toString('hex') === '1a45dfa3' ? 'MKV/EBML'
        : buf[0] === 0x47 ? 'MPEG-TS' : 'unknown(' + buf.subarray(0, 6).toString('hex') + ')';
    console.log(`  media: HTTP ${sr.status} ${buf.length}B magic=${magic} cr=${sr.headers.get('content-range') || '-'} ${magic !== 'unknown(' + buf.subarray(0, 6).toString('hex') + ')' ? '*** PLAYABLE ***' : ''}`);
  } catch (e) { console.log(`  media THROW: ${e?.message || e}`); }
}

for (let round = 1; round <= 2; round++) {
  console.log(`\n================ merged fetch ${round} ================`);
  const t0 = Date.now();
  const r = await jfetch(`${BASE}/stream/movie/tmdb:693134.json`);
  const streams = r.j?.streams || [];
  console.log(`HTTP ${r.status} in ${Date.now() - t0}ms streams=${streams.length} cc="${r.headers.get('cache-control')}"`);
  const stellar = findStellar(streams);
  console.log(`Stellar cards found: ${stellar.length}`);
  for (const c of stellar) console.log(`  - "${c.name}" q=${c.quality} url=${(c.url || '').slice(0, 90)}`);
  if (stellar.length) {
    for (let i = 0; i < Math.min(stellar.length, 2); i++) await playprobe(`stellar-${i + 1}`, stellar[i]);
    break;
  }
  if (round < 2) { console.log('(no stellar cards — 60s pause, then re-fetch)'); await sleep(60000); }
}
