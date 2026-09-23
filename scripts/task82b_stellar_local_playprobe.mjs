// Task 82b part 5: playprobe the locally-delivered StellarRip cards (Rigel 4K +
// Deneb 1080p) with the exact proxyHeaders the provider ships — proves the
// streams are real/playable and completes the egress-gate A/B picture.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const stellar = require('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');

const cards = await stellar.getStreams('693134', 'movie');
console.log(`provider returned ${cards.length} cards`);
for (const c of cards) {
  console.log(`\n=== ${c.name} | q=${c.quality} ===`);
  console.log(`url: ${c.url.slice(0, 110)}`);
  const h = c.behaviorHints?.proxyHeaders?.request || {};
  console.log(`proxyHeaders: ${JSON.stringify(h)}`);

  const t0 = Date.now();
  let master;
  try {
    const r = await fetch(c.url, { headers: { 'User-Agent': h['User-Agent'], Referer: h.Referer, Origin: h.Origin }, signal: AbortSignal.timeout(15000) });
    master = { status: r.status, text: await r.text() };
  } catch (e) { console.log(`master THROW: ${e?.message || e}`); continue; }
  console.log(`master: HTTP ${master.status} in ${Date.now() - t0}ms ${master.text.includes('#EXTM3U') ? '#EXTM3U OK' : 'NOT m3u8: ' + master.text.slice(0, 100)}`);
  if (!master.text.includes('#EXTM3U')) continue;

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
  console.log(`variants: ${variants.length} [${variants.map(v => `${v.w}x${v.h}@${Math.round(v.bw / 1000)}k`).join(', ')}]`);

  // probe best variant + first media segment
  if (!variants.length) continue;
  const vUrl = new URL(variants[0].uri, c.url).toString();
  const v = await (async () => { try { const r = await fetch(vUrl, { headers: { 'User-Agent': h['User-Agent'], Referer: h.Referer, Origin: h.Origin }, signal: AbortSignal.timeout(15000) }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } })();
  const segs = v.text.split('\n').filter(l => l && !l.startsWith('#'));
  const init = v.text.split('\n').find(l => l.startsWith('#EXT-X-MAP'))?.match(/URI="([^"]+)"/)?.[1];
  console.log(`variant: HTTP ${v.status} segments=${segs.length}${init ? ' initMap=yes' : ''}`);
  const firstMedia = init ? new URL(init, vUrl).toString() : segs[0] ? new URL(segs[0].trim(), vUrl).toString() : null;
  if (!firstMedia) continue;
  try {
    const sr = await fetch(firstMedia, { headers: { 'User-Agent': h['User-Agent'], Referer: h.Referer, Origin: h.Origin, Range: 'bytes=0-8191' }, signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await sr.arrayBuffer());
    const magic = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4(ftyp)' : buf[0] === 0x47 ? 'MPEG-TS' : 'unknown(' + buf.subarray(0, 6).toString('hex') + ')';
    console.log(`media: HTTP ${sr.status} ${buf.length}B magic=${magic} cr=${sr.headers.get('content-range') || '-'} ${magic.includes('fMP4') || magic === 'MPEG-TS' ? '*** PLAYABLE ***' : ''}`);
  } catch (e) { console.log(`media THROW: ${e?.message || e}`); }
}
