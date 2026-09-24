// Task 86: direct upstream probes from sandbox egress for the 9 still-zero sources.
// Goal: site alive? API changed? CF-gated only for Render?
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function probe(name, url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      redirect: opts.noRedirect ? 'manual' : 'follow',
      signal: AbortSignal.timeout(opts.timeout || 20000),
      method: opts.method || 'GET',
      body: opts.body,
    });
    const dt = Date.now() - t0;
    const loc = res.headers.get('location') || '';
    const ct = res.headers.get('content-type') || '';
    const body = res.status < 500 ? await res.text() : '';
    let sig = `${res.status} ${dt}ms ct=${ct.slice(0, 30)}`;
    if (loc) sig += ` loc=${loc.slice(0, 100)}`;
    console.log(`[${name}] ${sig} len=${body.length}`);
    return { name, status: res.status, dt, ct, loc, body };
  } catch (e) {
    console.log(`[${name}] FAIL ${Date.now() - t0}ms: ${e.message?.slice(0, 120)}`);
    return { name, status: 0, error: e.message };
  }
}

// ---- 1. verhdlink: Dune2 page that threw on prod (Inception page worked)
await probe('verhdlink-dune2-page', 'https://verhdlink.cam/movie/tt15239678', { timeout: 15000 });
// ---- 2. meinecloud: all fetches timeout at 15s
await probe('meinecloud-dune2-page', 'https://meinecloud.click/movie/tt15239678', { timeout: 20000 });
await probe('meinecloud-home', 'https://meinecloud.click/', { timeout: 15000 });
// ---- 3. zxcstream: token endpoints 404/302
await probe('zxc-player-home', 'https://player.zxcstream.xyz/', { timeout: 15000 });
await probe('zxc-token-burat', 'https://player.zxcstream.xyz/backend/burat', { method: 'POST', body: 'tmdb=693134', noRedirect: true, timeout: 15000 });
await probe('zxcprime-token-burat', 'https://player.zxcprime.xyz/backend/burat', { method: 'POST', body: 'tmdb=693134', timeout: 15000 });
// ---- 4. cinehdplus: series search silent zero
await probe('cinehdplus-home', 'https://cinehdplus.surf/', { timeout: 15000 });
// ---- 5. animezey workers
await probe('animezey-worker-23112022', 'https://1.animezey23112022.workers.dev/', { timeout: 15000 });
await probe('animezey-worker-dl', 'https://1.animezeydl.workers.dev/', { timeout: 15000 });
// ---- 6. atlantic artemis/aphrodite
await probe('atlantic-artemis', 'https://stellar.maybeoneday.ch/resolve', { timeout: 15000 });
await probe('atlantic-gate', 'https://atlantic.st/', { timeout: 15000 });
// ---- 7. kmmovies magiclinks
await probe('magiclinks-w3', 'https://w3.magiclinks.lol/', { timeout: 15000 });
// ---- 8. hindmoviez upstreams
await probe('mvlink-home', 'https://mvlink.blog/', { timeout: 20000 });
await probe('hindmoviez-wpjson', 'https://hindmovie.icu/wp-json/wp/v2/posts?search=Inception&per_page=5', { timeout: 25000 });
