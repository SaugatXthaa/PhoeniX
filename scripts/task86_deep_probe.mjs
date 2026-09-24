// Task 86 deep probes: cinehdplus search, meinecloud speed, verhdlink pages, mvlink flow, animezey 429 body, atlantic artemis
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchy(name, url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
      redirect: opts.noRedirect ? 'manual' : 'follow',
      signal: AbortSignal.timeout(opts.timeout || 25000),
      method: opts.method || 'GET',
      body: opts.body,
    });
    const dt = Date.now() - t0;
    const loc = res.headers.get('location') || '';
    const body = await res.text();
    console.log(`[${name}] ${res.status} ${dt}ms len=${body.length}${loc ? ' loc=' + loc.slice(0, 90) : ''}`);
    return { status: res.status, dt, body, headers: res.headers };
  } catch (e) {
    console.log(`[${name}] FAIL ${Date.now() - t0}ms: ${e.message?.slice(0, 100)}`);
    return { status: 0, error: e.message };
  }
}

// ---- 1. cinehdplus POST search (the code path: POST /index.php?do=search&subaction=search)
const chp = await fetchy('chp-search-bb', 'https://cinehdplus.surf/index.php?do=search&subaction=search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://cinehdplus.surf/', 'Origin': 'https://cinehdplus.surf' },
  body: 'story=Breaking+Bad&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50',
});
if (chp.status === 200) {
  const cardTitles = [...chp.body.matchAll(/class="card__title"[^>]*>\s*<a href="([^"]+)"[^>]*>([^<]+)</g)];
  console.log('  card__title matches:', cardTitles.length);
  for (const m of cardTitles.slice(0, 8)) console.log('   ', m[2].trim(), '→', m[1].slice(0, 80));
  // alternate markup probes
  console.log('  has .card__title:', chp.body.includes('card__title'), '| has peliculas:', chp.body.includes('/peliculas/'), '| has "Breaking"', /breaking/i.test(chp.body));
}

// ---- 2. meinecloud speed variance (3 fetches)
for (let i = 0; i < 3; i++) {
  await fetchy(`meinecloud-try${i + 1}`, 'https://meinecloud.click/movie/tt1375666', { timeout: 35000 });
}

// ---- 3. verhdlink: Inception page (worked on prod) vs Dune2 page (403) with full headers
const vh = await fetchy('verhdlink-inception', 'https://verhdlink.cam/movie/tt1375666', {
  headers: { 'Referer': 'https://verhdlink.cam/', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Upgrade-Insecure-Requests': '1' },
});
await fetchy('verhdlink-dune2-retry', 'https://verhdlink.cam/movie/tt15239678', {
  headers: { 'Referer': 'https://verhdlink.cam/', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Upgrade-Insecure-Requests': '1' },
});
if (vh.status === 200) {
  console.log('  verhdlink inception mirrors:', (vh.body.match(/_player-mirrors/g) || []).length, '| data-link count:', (vh.body.match(/data-link=/g) || []).length);
}

// ---- 4. mvlink actual processing pages (hindmoviez flow)
await fetchy('mvlink-web-6972', 'https://mvlink.blog/web/6972', { timeout: 25000 });

// ---- 5. animezey 429 body — what does it want?
const az = await fetchy('animezey-429-body', 'https://1.animezey23112022.workers.dev/', { timeout: 15000 });
if (az.status === 429) console.log('  429 body head:', az.body.slice(0, 300).replace(/\s+/g, ' '));

// ---- 6. atlantic artemis — replicate the exact resolve call shape
const art = await fetchy('atlantic-artemis-post', 'https://stellar.maybeoneday.ch/resolve', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://atlantic.st', 'Referer': 'https://atlantic.st/' },
  body: JSON.stringify({ id: 'tmdb:693134', type: 'movie' }), timeout: 20000,
});
if (art.status) console.log('  artemis body head:', art.body.slice(0, 200).replace(/\s+/g, ' '));
