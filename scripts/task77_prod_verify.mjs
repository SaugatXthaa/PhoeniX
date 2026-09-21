// Task 77 — production verification (rules.md #22): merged /stream on ≥2
// titles + playprobe one real antarctica card. Read-only probes.
const BASE = 'https://ignatiusphoenix.onrender.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
async function merged(type, id, label) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { signal: AbortSignal.timeout(80000) });
  const j = await r.json();
  const s = j.streams || [];
  const ant = s.filter(x => /antarctica/i.test(x.name || ''));
  const fourK = s.filter(x => /· 4K/.test(x.name || '')).length;
  const html = s.filter(x => /\.(html?)($|\?)/i.test(x.url || '')).length;
  const magnets = s.filter(x => /^magnet:/i.test(x.url || '')).length;
  const subs = s.filter(x => (x.subtitles || []).length > 0).length;
  console.log(`[prod] ${label}: total=${s.length} @${Date.now() - t0}ms | 4K=${fourK} | html=${html} | magnets=${magnets} | subs ${subs}/${s.length} | antarctica=${ant.length}`);
  check(`${label}: antarctica cards in production merged`, ant.length >= 1, `count=${ant.length}`);
  check(`${label}: antarctica direct https comet URLs`, ant.every(x => /^https:\/\/comet\.feels\.legal\//.test(x.url || '')));
  check(`${label}: zero html / zero magnets`, html === 0 && magnets === 0);
  return s;
}
(async () => {
  await merged('movie', 'tmdb:693134', 'movie Dune2 r1');
  await merged('series', 'tmdb:1396:1:1', 'series BBS01E1 r1');
  // playprobe one real production card (Range → 206 + EBML/ftyp)
  const fr = await fetch(`${BASE}/debug/source/antarctica?type=movie&id=tmdb:693134&full=1`, { signal: AbortSignal.timeout(60000) });
  const fj = await fr.json();
  const card = (fj.results || []).find(x => typeof x.url === 'string' && x.url.startsWith('http'));
  if (!card) throw new Error('no full card url');
  const pres = await fetch(card.url, {
    headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36' },
    redirect: 'follow', signal: AbortSignal.timeout(25000),
  });
  const buf = Buffer.from(await pres.arrayBuffer());
  const isMkv = buf.slice(0, 4).toString('hex') === '1a45dfa3';
  const isMp4 = buf.slice(4, 8).toString('latin1') === 'ftyp';
  console.log(`[prod] playprobe: status=${pres.status} ct=${pres.headers.get('content-type')} final=${new URL(pres.url).hostname} magic=${buf.slice(0, 4).toString('hex')}`);
  check('playprobe: 206 + real media magic + seekable', pres.status === 206 && (isMkv || isMp4) && pres.headers.get('accept-ranges') === 'bytes');
  console.log(`[prod] RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.log('[prod] ❌ ' + e.message); process.exit(1); });
