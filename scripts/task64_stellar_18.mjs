// Task 64: probe the REAL 18 source IDs from the site bundle across titles
const { createHash } = await import('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';

const SERVERS = ['s24','s25','s0','s2','s26','s19','s13','s4','s5','s6','s15','s7','s8','s16','s1','s12','s10','s3'];
const TITLES = process.argv.slice(2).length ? process.argv.slice(2) : ['movie:27205', 'movie:155', 'tv:1396-1-1', 'movie:671', 'movie:335984'];

async function resolveFor(tmdbId, type, tvSlug, source) {
  const embedPath = type === 'movie' ? `/en/watch/embed/movie/${tmdbId}` : `/en/watch/embed/tv/${tmdbId}-${tvSlug}`;
  const res = await fetch(BASE + embedPath, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieJar = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  await res.text();

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
    body: JSON.stringify({ mediaId: Number(tmdbId), mediaType: type, tv_slug: tvSlug, requestToken: tokData.token }),
    signal: AbortSignal.timeout(15000),
  });
  const initData = await initRes.json();
  let streamToken = initData.token;
  if (!streamToken && initData.requiresPow && initData.pow) {
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
      body: JSON.stringify({ mediaId: Number(tmdbId), mediaType: type, tv_slug: tvSlug, requestToken: tokData.token, pow: { challengeId, nonce: String(nonce) } }),
      signal: AbortSignal.timeout(15000),
    });
    const solveData = await solveRes.json();
    streamToken = solveData.token;
  }
  if (!streamToken) throw new Error('no streamToken');

  const out = {};
  await Promise.all(SERVERS.map(async (source) => {
    const encRes = await fetch(BASE + '/api/encrypt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
      body: JSON.stringify({ data: { mediaId: Number(tmdbId), mediaType: type, tv_slug: tvSlug, source }, endpoint: 'stream-encrypted', requestToken: tokData.token }),
      signal: AbortSignal.timeout(12000),
    });
    if (!encRes.ok) { out[source] = 'enc HTTP ' + encRes.status; return; }
    const encData = await encRes.json().catch(() => null);
    if (!encData?.url) { out[source] = 'no url'; return; }
    const opaque = encData.url + (encData.url.includes('?') ? '&' : '?') + 'requestToken=' + encodeURIComponent(tokData.token) + '&token=' + encodeURIComponent(streamToken);
    const sRes = await fetch(BASE + opaque, { headers: { Referer: BASE + embedPath, 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!sRes.ok) { out[source] = 'stream HTTP ' + sRes.status; return; }
    const sData = await sRes.json().catch(() => null);
    const su = sData?.data?.stream_url;
    out[source] = su ? (su.includes('playback-unavailable') ? 'UNAVAIL' : su.slice(0, 90)) : 'no stream_url';
  }));
  return out;
}

for (const t of TITLES) {
  const [kind, rest] = t.split(':');
  let tmdbId, type, tvSlug = '';
  if (kind === 'movie') { type = 'movie'; tmdbId = rest; }
  else { type = 'tv'; const p = rest.split('-'); tmdbId = p[0]; tvSlug = `${p[1]}-${p[2]}`; }
  console.log(`\n===== ${t} =====`);
  try {
    const out = await resolveFor(tmdbId, type, tvSlug);
    for (const [s, v] of Object.entries(out)) console.log(`  ${s}: ${v}`);
  } catch (e) { console.log('  ERR', e.message); }
}
