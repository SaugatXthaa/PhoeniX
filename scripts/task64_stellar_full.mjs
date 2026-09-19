// Task 64: full /api/encrypt response dump + search frontend bundle for new endpoints
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';
const { createHash } = await import('crypto');

const TMDB_ID = '27205';
const embedPath = `/en/watch/embed/movie/${TMDB_ID}`;

const res = await fetch(BASE + embedPath, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
const cookieJar = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
const html = await res.text();

const tokRes = await fetch(BASE + '/api/request-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: cookieJar },
  body: '{}', signal: AbortSignal.timeout(15000),
});
const tokData = await tokRes.json();
const merged = [cookieJar, ...(tokRes.headers.getSetCookie ? tokRes.headers.getSetCookie().map(c => c.split(';')[0]) : [])].filter(Boolean).join('; ');

const initRes = await fetch(BASE + '/api/playback-init', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
  body: JSON.stringify({ mediaId: Number(TMDB_ID), mediaType: 'movie', tv_slug: '', requestToken: tokData.token }),
  signal: AbortSignal.timeout(15000),
});
const initData = await initRes.json();
const { challengeId, challenge, difficulty } = initData.pow;
let nonce = -1;
const byteCount = Math.floor(difficulty / 8), extraBits = difficulty % 8;
const extraMask = extraBits ? (0xFF << (8 - extraBits)) & 0xFF : 0;
for (let n = 0; n < 300000000; n++) {
  const h = createHash('sha256').update(challenge + n).digest();
  let ok = true;
  for (let i = 0; i < byteCount; i++) if (h[i] !== 0) { ok = false; break; }
  if (ok && extraMask && (h[byteCount] & extraMask) !== 0) ok = false;
  if (ok) { nonce = n; break; }
}
const solveRes = await fetch(BASE + '/api/playback-init', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
  body: JSON.stringify({ mediaId: Number(TMDB_ID), mediaType: 'movie', tv_slug: '', requestToken: tokData.token, pow: { challengeId, nonce: String(nonce) } }),
  signal: AbortSignal.timeout(15000),
});
const solveData = await solveRes.json();
const streamToken = solveData.token;
console.log('streamToken ok:', !!streamToken);

// FULL encrypt response for s0..s2 (dump raw JSON, all fields)
for (const source of ['s0', 's1', 's2', 's17']) {
  const encRes = await fetch(BASE + '/api/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
    body: JSON.stringify({ data: { mediaId: Number(TMDB_ID), mediaType: 'movie', tv_slug: '', source }, endpoint: 'stream-encrypted', requestToken: tokData.token }),
    signal: AbortSignal.timeout(12000),
  });
  const raw = await encRes.text();
  console.log(`\n=== ${source} encrypt HTTP ${encRes.status} ===`);
  console.log(raw.slice(0, 600));
}

// Also try alternative endpoints seen in other extractors
for (const ep of ['/api/stream', '/api/sources', '/api/servers', '/api/stream-servers']) {
  try {
    const r = await fetch(BASE + ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
      body: JSON.stringify({ mediaId: Number(TMDB_ID), mediaType: 'movie', tv_slug: '', requestToken: tokData.token, token: streamToken }),
      signal: AbortSignal.timeout(8000),
    });
    const t = await r.text();
    console.log(`\nPOST ${ep} -> ${r.status} : ${t.slice(0, 200)}`);
  } catch (e) { console.log(`POST ${ep} -> ERR ${e.message}`); }
}
