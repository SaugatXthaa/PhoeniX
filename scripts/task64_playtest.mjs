// Task 64: player-path playability for fixed sources' cards
const BASE = 'http://localhost:4596';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function probeHls(url, depth = 0) {
  // master → variant → segment (via the exact URLs the card carries)
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, level: depth };
  if (depth === 0 && text.startsWith('#EXTM3U')) {
    // pick first variant (skip comment lines)
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) return { ok: false, status: 'no-variants', level: depth };
    const variantUrl = new URL(lines[0], url).toString();
    const v = await probeHls(variantUrl, depth + 1);
    return { ...v, master: true, variants: lines.length };
  }
  if (depth >= 1 && text.startsWith('#EXTM3U')) {
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) return { ok: false, status: 'no-segments', level: depth };
    const segUrl = new URL(lines[0], url).toString();
    const s = await fetch(segUrl, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await s.arrayBuffer());
    return { ok: s.ok, status: s.status, level: 2, bytes: buf.length, head: [...buf.slice(0, 8)] };
  }
  return { ok: true, status: res.status, level: depth, note: 'non-hls body' };
}

// zxcstream card (JJK S1E1)
const zxc = await (await fetch(`${BASE}/debug/source/zxcstream?type=series&id=tmdb:95479:1:1`, { headers: { 'x-request-id': 't64' } })).json();
if (zxc.results?.length) {
  const card = zxc.results[0];
  console.log('zxcstream card:', (card.url || '').slice(0, 80));
  const r = await probeHls(card.url);
  console.log('  player path:', JSON.stringify(r).slice(0, 220));
  // subtitle track check
  if (card.subtitles?.length) {
    const s = card.subtitles[0];
    const sres = await fetch(s.url, { headers: { 'User-Agent': UA, Referer: 'https://mfw09.org/' }, signal: AbortSignal.timeout(12000) });
    const st = await sres.text();
    console.log(`  sub [${s.lang || s.name}]:`, sres.status, st.slice(0, 40).replace(/\n/g, ' '));
  }
}

// animekai card
const kai = await (await fetch(`${BASE}/debug/source/animekai?type=series&id=tmdb:95479:1:1`, { headers: { 'x-request-id': 't64' } })).json();
if (kai.results?.length) {
  const card = kai.results[0];
  console.log('animekai card:', (card.url?.href || '').slice(0, 80));
  const r = await probeHls(card.url.href);
  console.log('  player path:', JSON.stringify(r).slice(0, 220));
}

// animeworldindia card
const aw = await (await fetch(`${BASE}/debug/source/animeworldindia?type=series&id=tmdb:95479:1:1`, { headers: { 'x-request-id': 't64' } })).json();
if (aw.results?.length) {
  const card = aw.results[0];
  console.log('animeworldindia card:', (card.url || '').slice(0, 80));
  const r = await probeHls(card.url);
  console.log('  player path:', JSON.stringify(r).slice(0, 220));
}
