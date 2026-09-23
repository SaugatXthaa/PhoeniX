// Task 82b part 6: one-shot spaced local retry (Inception) + immediate
// playprobe; plus prod-egress probe of an ALREADY-ISSUED stream URL (is the
// gate on new encrypts only, or on playback too?).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getStreams } = require('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');

const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function playprobeCards(cards) {
  let probed = 0;
  for (const c of cards) {
    const h = c.behaviorHints?.proxyHeaders?.request || {};
    console.log(`\n=== ${c.name} | q=${c.quality} ===`);
    console.log(`url: ${c.url.slice(0, 130)}`);
    let m;
    try {
      const r = await fetch(c.url, { headers: { 'User-Agent': h['User-Agent'], Referer: h.Referer, Origin: h.Origin }, signal: AbortSignal.timeout(15000) });
      m = { status: r.status, text: await r.text() };
    } catch (e) { console.log(`master THROW: ${e?.message || e}`); continue; }
    if (!m.text.includes('#EXTM3U')) { console.log(`master HTTP ${m.status} not m3u8: ${m.text.slice(0, 90)}`); continue; }
    const lines = m.text.split('\n');
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/), bw = lines[i].match(/BANDWIDTH=(\d+)/);
        const uri = lines[i + 1];
        if (uri && !uri.startsWith('#')) variants.push({ w: res ? +res[1] : 0, h: res ? +res[2] : 0, bw: bw ? +bw[1] : 0, uri: uri.trim() });
      }
    }
    variants.sort((a, b) => b.bw - a.bw);
    console.log(`master 200 #EXTM3U variants=${variants.length} [${variants.map(v => `${v.w}x${v.h}@${Math.round(v.bw / 1000)}k`).join(', ')}]`);
    if (!variants.length) continue;
    const vUrl = new URL(variants[0].uri, c.url).toString();
    let v;
    try { const r = await fetch(vUrl, { headers: { 'User-Agent': h['User-Agent'], Referer: h.Referer, Origin: h.Origin }, signal: AbortSignal.timeout(15000) }); v = { status: r.status, text: await r.text() }; }
    catch (e) { console.log(`variant THROW: ${e?.message || e}`); continue; }
    const segs = v.text.split('\n').filter(l => l && !l.startsWith('#'));
    const init = v.text.split('\n').find(l => l.startsWith('#EXT-X-MAP'))?.match(/URI="([^"]+)"/)?.[1];
    console.log(`variant HTTP ${v.status} segments=${segs.length}${init ? ' initMap=yes' : ''}`);
    const firstMedia = init ? new URL(init, vUrl).toString() : segs[0] ? new URL(segs[0].trim(), vUrl).toString() : null;
    if (!firstMedia) continue;
    try {
      const sr = await fetch(firstMedia, { headers: { 'User-Agent': h['User-Agent'], Referer: h.Referer, Origin: h.Origin, Range: 'bytes=0-8191' }, signal: AbortSignal.timeout(15000) });
      const buf = Buffer.from(await sr.arrayBuffer());
      const magic = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4(ftyp)' : buf[0] === 0x47 ? 'MPEG-TS' : 'unknown(' + buf.subarray(0, 6).toString('hex') + ')';
      console.log(`media HTTP ${sr.status} ${buf.length}B magic=${magic} ${magic.includes('fMP4') || magic === 'MPEG-TS' ? '*** PLAYABLE ***' : ''}`);
      probed++;
    } catch (e) { console.log(`media THROW: ${e?.message || e}`); }
  }
  return probed;
}

// 1. spaced local retry (Inception), immediate playprobe on delivery
console.log('--- local retry after 90s cooldown (Inception tmdb:27205) ---');
await sleep(90000);
const cards = await getStreams('27205', 'movie');
console.log(`local provider: ${cards.length} cards`);
let probed = 0;
if (cards.length) probed = await playprobeCards(cards);
console.log(`\nLOCAL DELIVERY+PROBE: ${cards.length} cards, ${probed} playprobed OK`);

// 2. prod-egress probe of an already-issued stream URL (from the earlier
//    successful local window; URL printed at 100-char slice — try both cards)
console.log('\n--- prod-egress fetch of ALREADY-ISSUED stellarrip stream URLs ---');
const issued = [
  { label: 'Rigel-4K (possibly 1ch truncated)', url: 'https://proxy2.jordanblackwell.bid/playlist/F9RaAfI9cdujimREC4WXhWN0hKMTLIfaRZ30J29e5Rhp5NGdvtPz4Uxo' },
  { label: 'Deneb-1080p (possibly 1ch truncated)', url: 'https://proxy2.jordanblackwell.bid/playlist/vWczRo84-RlVdKcPtjMnt0As3iaU1bkgTtRkcJQwO1rPjEC8UeEpkHrg' },
];
const embedRef = 'https://stellar.rip/en/watch/embed/movie/693134';
for (const c of issued) {
  const q = new URLSearchParams({ url: c.url, referer: embedRef });
  try {
    const r = await fetch(`${BASE}/debug/rawfetch?${q}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    console.log(`  ${c.label}: HTTP ${j.status} bytes=${j.bytes} ct=${j.ct || '-'} head=${(j.head || '').slice(0, 60).replace(/\n/g, ' ')}${j.error ? ' err=' + j.error : ''}`);
  } catch (e) { console.log(`  ${c.label}: THROW ${e?.message || e}`); }
}
