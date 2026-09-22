// Task 82 — measure stellar.rip playback-init latency distribution with a real session.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';

for (let round = 1; round <= 3; round++) {
  const t0 = Date.now();
  const stamps = [];
  const mark = (n) => stamps.push(`${n}@${((Date.now() - t0) / 1000).toFixed(1)}s`);
  try {
    const er = await fetch(BASE + '/en/watch/embed/movie/693134', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    mark('embed:' + er.status);
    const jar = (er.headers.getSetCookie ? er.headers.getSetCookie().map(c => c.split(';')[0]) : []).filter(Boolean).join('; ');
    await er.body?.cancel().catch(() => {});
    const tr = await fetch(BASE + '/api/request-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, Referer: BASE + '/en/watch/embed/movie/693134', 'User-Agent': UA, Cookie: jar },
      body: JSON.stringify({ path: '/watch/embed/movie/693134', embedPlayback: true }),
      signal: AbortSignal.timeout(15000),
    });
    mark('reqtok:' + tr.status);
    const tok = (await tr.json()).token;
    const ir = await fetch(BASE + '/api/playback-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, Referer: BASE + '/en/watch/embed/movie/693134', 'User-Agent': UA, Cookie: jar },
      body: JSON.stringify({ mediaId: 693134, mediaType: 'movie', tv_slug: '', requestToken: tok }),
      signal: AbortSignal.timeout(20000),
    });
    mark('init:' + ir.status);
    const init = await ir.json();
    if (init.requiresPow && init.pow) {
      console.log(`round ${round}: ${stamps.join(' ')} | PoW difficulty=${init.pow.difficulty}`);
    } else {
      console.log(`round ${round}: ${stamps.join(' ')} | no-PoW token=${!!init.token}`);
    }
  } catch (e) {
    console.log(`round ${round}: ${stamps.join(' ')} | FAIL ${e.message.slice(0, 60)}`);
  }
  await new Promise(r => setTimeout(r, 2000));
}
