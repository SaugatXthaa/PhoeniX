// Task 64: probe stellar.rip — user reports the site works with 18 servers up to 4K.
// Our impl only knows 6 sources (s0-s5). Check current API shape.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';
const TMDB_ID = process.argv[2] || '27205'; // Inception
const TYPE = process.argv[3] || 'movie';

const embedPath = TYPE === 'movie' ? `/en/watch/embed/movie/${TMDB_ID}` : `/en/watch/embed/tv/${TMDB_ID}-1-1`;

// Step 1: embed page + cookies
const res = await fetch(BASE + embedPath, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
console.log('embed status:', res.status);
const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
const cookieJar = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
console.log('cookies:', cookieJar.slice(0, 120));
const html = await res.text();
console.log('embed html len:', html.length);
const inline = html.match(/__REQUEST_TOKEN__\s*=\s*"([^"]+)"/);
console.log('inline token:', inline ? 'YES' : 'no');
// dump interesting bits of the embed page
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
console.log('script srcs:', scripts.slice(0, 20).join('\n  '));

// request-token bootstrap
const tokRes = await fetch(BASE + '/api/request-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, ...(cookieJar && { Cookie: cookieJar }) },
  body: '{}', signal: AbortSignal.timeout(15000),
});
console.log('\nrequest-token:', tokRes.status);
const tokData = await tokRes.json().catch(() => null);
console.log('token data keys:', tokData ? Object.keys(tokData) : null);
if (tokData?.token) {
  const merged = [cookieJar, ...(tokRes.headers.getSetCookie ? tokRes.headers.getSetCookie().map(c => c.split(';')[0]) : [])].filter(Boolean).join('; ');
  console.log('requestToken (first 40):', tokData.token.slice(0, 40));

  // Step 2: playback-init → PoW
  crypto: {
    const { createHash } = await import('crypto');
    const initRes = await fetch(BASE + '/api/playback-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
      body: JSON.stringify({ mediaId: Number(TMDB_ID), mediaType: TYPE, tv_slug: TYPE === 'tv' ? '1-1' : '', requestToken: tokData.token }),
      signal: AbortSignal.timeout(15000),
    });
    console.log('\nplayback-init:', initRes.status);
    const initData = await initRes.json().catch(() => null);
    console.log('init:', JSON.stringify(initData).slice(0, 400));
    if (initData?.requiresPow && initData.pow) {
      const { challengeId, challenge, difficulty } = initData.pow;
      console.log('PoW difficulty:', difficulty);
      let nonce = -1;
      const byteCount = Math.floor(difficulty / 8);
      const extraBits = difficulty % 8;
      const extraMask = extraBits ? (0xFF << (8 - extraBits)) & 0xFF : 0;
      const t0 = Date.now();
      for (let n = 0; n < 300000000; n++) {
        const h = createHash('sha256').update(challenge + n).digest();
        let ok = true;
        for (let i = 0; i < byteCount; i++) if (h[i] !== 0) { ok = false; break; }
        if (ok && extraMask && (h[byteCount] & extraMask) !== 0) ok = false;
        if (ok) { nonce = n; break; }
      }
      console.log('PoW solved nonce:', nonce, 'in', Date.now() - t0, 'ms');
      const solveRes = await fetch(BASE + '/api/playback-init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
        body: JSON.stringify({ mediaId: Number(TMDB_ID), mediaType: TYPE, tv_slug: TYPE === 'tv' ? '1-1' : '', requestToken: tokData.token, pow: { challengeId, nonce: String(nonce) } }),
        signal: AbortSignal.timeout(15000),
      });
      console.log('solve:', solveRes.status);
      const solveData = await solveRes.json().catch(() => null);
      console.log('solve keys:', solveData ? Object.keys(solveData) : null, solveData?.success);
      const streamToken = solveData?.token;
      if (streamToken) {
        // Step 3: enumerate sources — user says 18 servers. Try s0..s17.
        const results = await Promise.allSettled(Array.from({ length: 18 }, (_, i) => i).map(async (i) => {
          const source = 's' + i;
          const encRes = await fetch(BASE + '/api/encrypt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + embedPath, 'User-Agent': UA, Cookie: merged },
            body: JSON.stringify({ data: { mediaId: Number(TMDB_ID), mediaType: TYPE, tv_slug: TYPE === 'tv' ? '1-1' : '', source }, endpoint: 'stream-encrypted', requestToken: tokData.token }),
            signal: AbortSignal.timeout(12000),
          });
          if (!encRes.ok) return { source, err: 'HTTP ' + encRes.status };
          const encData = await encRes.json().catch(() => null);
          if (!encData?.url) return { source, err: 'no url', body: JSON.stringify(encData).slice(0, 100) };
          const opaque = encData.url + (encData.url.includes('?') ? '&' : '?') + 'requestToken=' + encodeURIComponent(tokData.token) + '&token=' + encodeURIComponent(streamToken);
          const sRes = await fetch(BASE + opaque, { headers: { Referer: BASE + embedPath, 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
          if (!sRes.ok) return { source, err: 'stream HTTP ' + sRes.status };
          const sData = await sRes.json().catch(() => null);
          return { source, status: sData?.success, url: sData?.data?.stream_url?.slice(0, 100) || JSON.stringify(sData).slice(0, 120) };
        }));
        for (const r of results) console.log(r.status === 'fulfilled' ? JSON.stringify(r.value) : 'REJ ' + r.reason);
      }
    }
  }
}
