// Task 86c: distinguish fetch-mode vs egress for mvlink tarpit + acer chain + zxc variants
const { gotScraping } = await import('file:///home/z/my-project/ignatiusphoenix/node_modules/got-scraping/dist/index.js');

// ---- 1. mvlink.blog: plain fetch vs got-scraping (chrome TLS) from same egress
const T = (p) => `https://mvlink.blog${p}`;
for (const [label, fn] of [
  ['plain-fetch', async (url) => {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(20000) });
    return `${r.status} len=${(await r.text()).length}`;
  }],
  ['got-scraping-chrome', async (url) => {
    const r = await gotScraping.get({ url, headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] }, timeout: { request: 20000 }, throwHttpErrors: false });
    return `${r.statusCode} len=${r.body.length}`;
  }],
]) {
  for (const p of ['/web/6972', '/19364']) {
    const t0 = Date.now();
    try { console.log(`mvlink ${label} ${p} → ${await fn(T(p))} (${Date.now() - t0}ms)`); }
    catch (e) { console.log(`mvlink ${label} ${p} → FAIL ${e.message.slice(0, 50)} (${Date.now() - t0}ms)`); }
  }
}

// ---- 2. hshare.ink f.php (the successful bypass target that timed out on prod)
{
  const t0 = Date.now();
  try {
    const r = await fetch('https://hshare.ink/?id=Dune.Part.Two.2024.1080p.x264.WEB-DL.Hindi.English.Msubs..mkv', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(20000), redirect: 'manual',
    });
    console.log(`hshare.ink plain → ${r.status} loc=${(r.headers.get('location') || '').slice(0, 80)} (${Date.now() - t0}ms)`);
  } catch (e) { console.log(`hshare.ink plain → FAIL ${e.message.slice(0, 50)} (${Date.now() - t0}ms)`); }
}

// ---- 3. zxcstream/zxcprime variants (token endpoints migrated?)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
for (const [tag, url] of [
  ['zxcprime-GET', 'https://player.zxcprime.xyz/backend/burat', {}],
  ['zxcprime-home', 'https://player.zxcprime.xyz/', {}],
  ['zxcstream-embed', 'https://player.zxcstream.xyz/embed/movie/27205', {}],
  ['zxcstream-api', 'https://player.zxcstream.xyz/api/source/27205', {}],
]) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://player.zxcstream.xyz/' }, signal: AbortSignal.timeout(12000), redirect: 'manual' });
    const b = r.status < 500 ? await r.text() : '';
    console.log(`${tag} → ${r.status} loc=${(r.headers.get('location') || '').slice(0, 70)} len=${b.length} (${Date.now() - t0}ms)${b.length && b.length < 200 ? ' body=' + b.slice(0, 100).replace(/\s+/g, ' ') : ''}`);
  } catch (e) { console.log(`${tag} → FAIL ${e.message.slice(0, 40)} (${Date.now() - t0}ms)`); }
}
