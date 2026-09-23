// Task 84: fresh ground-truth probes for the 8 zero sources (from sandbox DC egress)
// Usage: node scripts/task84_groundtruth.mjs <section>
import { gotScraping as got } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function timedFetch(url, opts = {}, timeout = 15000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    const body = await r.text();
    return { status: r.status, ms: Date.now() - t0, body, headers: Object.fromEntries(r.headers.entries()) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: '', error: String(e?.cause?.message || e?.message || e).slice(0, 120) };
  }
}

async function timedGot(url, opts = {}, timeout = 15000) {
  const t0 = Date.now();
  try {
    const r = await got({ url, timeout: { request: timeout }, throwHttpErrors: false, http2: false, ...opts });
    return { status: r.statusCode, ms: Date.now() - t0, body: r.body, headers: r.headers };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: '', error: String(e?.cause?.message || e?.code || e?.message || e).slice(0, 120) };
  }
}

const sec = process.argv[2] || 'all';

// ---------- 1. framextv transport A/B ----------
async function framextv() {
  console.log('=== FRAMEXTV transport A/B (sandbox egress) ===');
  const url = 'https://api.framextv.tech/api/stream?type=movie&id=693134&provider=barbarian';
  const f = await timedFetch(url, { headers: { Accept: 'application/json' } }, 12000);
  console.log(`plain-fetch : ${f.status} @${f.ms}ms ${f.error || 'len=' + f.body.length} ${(f.body.match(/"quality":"[^"]+"/g) || []).slice(0, 3)}`);
  await new Promise(r => setTimeout(r, 1500));
  const g = await timedGot(url, { headers: { Accept: 'application/json', Referer: 'https://framextv.tech/' } }, 12000);
  console.log(`got-scraping: ${g.status} @${g.ms}ms ${g.error || 'len=' + g.body.length} ${(g.body.match(/"quality":"[^"]+"/g) || []).slice(0, 3)}`);

  // burst behavior: 5 parallel like the sweep does
  console.log('--- burst of 5 parallel (got-scraping, like the sweep) ---');
  const provs = ['barbarian', 'goblin', 'super_barbarian', 'electro_wizard', 'lavahound'];
  const t0 = Date.now();
  const rs = await Promise.allSettled(provs.map(p =>
    timedGot(`https://api.framextv.tech/api/stream?type=movie&id=693134&provider=${p}`, { headers: { Accept: 'application/json', Referer: 'https://framextv.tech/' } }, 10000)));
  rs.forEach((r, i) => console.log(`  ${provs[i]}: ${r.value.status} @${r.value.ms}ms ${r.value.error || ''} len=${r.value.body.length}`));
  console.log(`burst total: ${Date.now() - t0}ms`);
}

// ---------- 2. persianstremio ----------
async function persianstremio() {
  console.log('=== PERSIANSTREMIO (sandbox egress) ===');
  const targets = [
    'https://persianstremio.vercel.app/stream/movie/tt1375666.json',   // warm tt (Inception)
    'https://persianstremio.vercel.app/stream/movie/tt15239678.json',  // cold tt (Dune2)
  ];
  for (const t of targets) {
    const r = await timedFetch(t, {}, 40000);
    console.log(`${t.slice(-30)}: ${r.status} @${r.ms}ms ${r.error || ''} len=${r.body.length}`);
    if (r.body && r.status === 200) {
      try { const j = JSON.parse(r.body); console.log('  streams:', (j.streams || []).length, JSON.stringify((j.streams || [])[0] || {}).slice(0, 200)); } catch { }
    }
  }
}

// ---------- 3. uhdmovies site structure ----------
async function uhdmovies() {
  console.log('=== UHDMOVIES site (sandbox egress) ===');
  const home = await timedFetch('https://uhdmovies.my/', {}, 15000);
  console.log(`home: ${home.status} @${home.ms}ms len=${home.body.length} ${home.error || ''}`);
  if (home.status !== 200) {
    const alt = await timedFetch('https://uhdmovies.autos/', {}, 15000);
    console.log(`uhdmovies.autos: ${alt.status} @${alt.ms}ms len=${alt.body.length} final-host=${alt.headers['location'] || 'n/a'}`);
    if (alt.body) console.log('  body sample:', alt.body.slice(0, 300).replace(/\s+/g, ' '));
    return;
  }
  // search for a Dune post
  const search = await timedFetch('https://uhdmovies.my/?s=dune', {}, 15000);
  const links = [...search.body.matchAll(/href="(https:\/\/uhdmovies\.my\/[^"]*dune[^"]*)"/gi)].map(m => m[1]).slice(0, 5);
  console.log('dune posts:', [...new Set(links)]);
  if (links[0]) {
    const post = await timedFetch(links[0], {}, 15000);
    console.log(`post: ${post.status} @${post.ms}ms len=${post.body.length}`);
    const hosts = {};
    for (const m of post.body.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
      try { const h = new URL(m[1]).hostname; if (!/uhdmovies|gravatar|wp\.com|wordpress|gmpg|w3\.org|schema/.test(h)) hosts[h] = (hosts[h] || 0) + 1; } catch { }
    }
    console.log('outbound hosts:', JSON.stringify(hosts));
    const naukri = [...post.body.matchAll(/href="(https?:\/\/[^"]*naukriadda[^"]*)"/g)].map(m => m[1]).slice(0, 3);
    console.log('naukriadda links:', naukri);
  }
}

// ---------- 4. kmmovies post host inventory ----------
async function kmmovies() {
  console.log('=== KMMOVIES post (sandbox egress) ===');
  const post = await timedFetch('https://kmmovies.rest/dune-part-two-2024-dual-audio-hindi-english-download-2160p-bluray', {}, 20000);
  console.log(`post: ${post.status} @${post.ms}ms len=${post.body.length} ${post.error || ''}`);
  const hosts = {};
  for (const m of post.body.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    try { const h = new URL(m[1]).hostname; if (!/kmmovies|wp\.com|gravatar|w3\.org|gmpg|schema|fonts/.test(h)) hosts[h] = (hosts[h] || 0) + 1; } catch { }
  }
  console.log('outbound hosts:', JSON.stringify(hosts));
  console.log('magiclinks:', [...post.body.matchAll(/https?:\/\/w3\.magiclinks\.lol[^"'< ]+/g)].map(m => m[0]).slice(0, 3));
  console.log('hubcloud:', [...post.body.matchAll(/https?:\/\/hubcloud\.[a-z.]+\/[^"'< ]+/g)].map(m => m[0]).slice(0, 3));
}

// ---------- 5. animeworldindia ----------
async function animeworldindia() {
  console.log('=== ANIMEWORLDINDIA (sandbox egress) ===');
  const bases = ['https://watchanimeworld.one', 'https://animeworld-india.me', 'https://animeworldindia.co', 'https://ww1.animeworld-india.cc', 'https://animeworld-india.cc'];
  for (const b of bases) {
    const r = await timedFetch(b, {}, 12000);
    console.log(`${b}: ${r.status} @${r.ms}ms ${r.error || ''} len=${r.body.length}`);
    if (r.status === 403) console.log('  cf?', /cloudflare|challenge|cf-/i.test(r.body) || r.headers['server'] || '');
  }
}

// ---------- 6. anineko ----------
async function anineko() {
  console.log('=== ANINEKO (sandbox egress) ===');
  const r = await timedFetch('https://anineko.to/search?query=jzz', {}, 12000).catch(() => null);
  // actual API probing below
  const tries = [
    'https://anineko.to/api/search?q=jujutsu',
    'https://anineko.to/search?query=jujutsu kaisen',
    'https://anineko.to/anime?search=jujutsu',
  ];
  for (const t of tries) {
    const r2 = await timedFetch(t, { headers: { Accept: 'application/json' } }, 12000);
    console.log(`${t}: ${r2.status} @${r2.ms}ms len=${r2.body.length} ${r2.error || ''}`);
    if (r2.body) console.log('  ', r2.body.slice(0, 200).replace(/\s+/g, ' '));
  }
}

const sections = { framextv, persianstremio, uhdmovies, kmmovies, animeworldindia, anineko };
if (sec === 'all') { for (const [k, fn] of Object.entries(sections)) { try { await fn(); } catch (e) { console.log(k, 'ERR', e.message); } } }
else if (sections[sec]) await sections[sec];
