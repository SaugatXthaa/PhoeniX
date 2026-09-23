// Task 84 probe #2: deep chains (driveseed, magiclinks, relays, anineko mirrors)
import { gotScraping as got } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function tf(url, opts = {}, timeout = 20000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual', ...opts, signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    const body = await r.text();
    return { status: r.status, ms: Date.now() - t0, body, headers: Object.fromEntries(r.headers.entries()) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: '', error: String(e?.cause?.message || e?.message || e).slice(0, 120) };
  }
}

// ---------- A. uhdmovies: trace driveseed links from the Dune2 post ----------
async function driveseed() {
  console.log('=== UHDMOVIES → DRIVESEED trace ===');
  const post = await tf('https://uhdmovies.my/download-dune-part-two-2024-dual-audio-hindi-english-1080p-x264-bluray-esubs/', {}, 20000);
  const ds = [...new Set([...post.body.matchAll(/href="(https?:\/\/[^"]*driveseed[^"]*)"/g)].map(m => m[1]))];
  console.log('driveseed links:', ds.slice(0, 4), `(${ds.length} total)`);
  // also check the 4K post for thenaukriadda class
  const post4k = await tf('https://uhdmovies.my/download-dune-prophecy-2024-season-1-s01e01-added-dual-audio-hindi-english-2160p-4k-1080p-1080p-10bit-x264-hevc-hdr-dovi-web-dl-esubs/', {}, 20000);
  const hosts4k = {};
  for (const m of post4k.body.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    try { const h = new URL(m[1]).hostname; if (!/uhdmovies|wp\.|gravatar|w3\.org|gmpg|schema|fonts|telegram|t\.me/.test(h)) hosts4k[h] = (hosts4k[h] || 0) + 1; } catch { }
  }
  console.log('4k-post outbound hosts:', JSON.stringify(hosts4k));
  if (!ds.length) return;
  const page = await tf(ds[0], { headers: { Referer: 'https://uhdmovies.my/' } }, 20000);
  console.log(`driveseed page: ${page.status} @${page.ms}ms len=${page.body.length} ${page.error || ''}`);
  if (page.body) {
    const out = {};
    for (const m of page.body.matchAll(/(?:href|action|src)="(https?:\/\/[^"]+)"/g)) {
      try { const h = new URL(m[1]).hostname; if (!/driveseed|wp\.|google|gstatic/.test(h)) out[h] = (out[h] || 0) + 1; } catch { }
    }
    console.log('driveseed outbound:', JSON.stringify(out));
    console.log('body sample:', page.body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\s+/g, ' ').slice(0, 500));
  }
}

// ---------- B. kmmovies: resolve one magiclinks with the repo resolver ----------
async function magiclinks() {
  console.log('=== KMMOVIES magiclinks resolve (repo resolver) ===');
  const { resolveMagiclinks } = await import('/home/z/my-project/phoenix-analysis/src/nuvio/kmmovies.cjs');
  const t0 = Date.now();
  try {
    const res = await resolveMagiclinks('https://w3.magiclinks.lol/80485601-2/');
    console.log(`resolved in ${Date.now() - t0}ms:`, JSON.stringify(res).slice(0, 600));
  } catch (e) {
    console.log(`resolver ERR after ${Date.now() - t0}ms:`, e.message);
  }
}

// ---------- C. animeworldindia: relay fetch test ----------
async function awiRelay() {
  console.log('=== ANIMEWORLDINDIA relay test ===');
  const target = 'https://watchanimeworld.one/';
  const relays = [
    ['allorigins', `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`],
    ['corsproxy.io', `https://corsproxy.io/?url=${encodeURIComponent(target)}`],
    ['codetabs', `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`],
  ];
  for (const [name, url] of relays) {
    const r = await tf(url, {}, 20000);
    console.log(`${name}: ${r.status} @${r.ms}ms len=${r.body.length} ${r.error || ''} ${r.body.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}

// ---------- D. anineko mirrors ----------
async function anineko() {
  console.log('=== ANINEKO mirrors/health ===');
  for (const d of ['anineko.to', 'anineko.com', 'anineko.net', 'anineko.to', 'nekovault.online']) {
    const r = await tf(`https://${d}/`, {}, 10000);
    console.log(`${d}: ${r.status} @${r.ms}ms len=${r.body.length} ${r.error || ''}`);
  }
  const home = await tf('https://anineko.to/', {}, 10000);
  const m = home.body.match(/nekovault[a-z.]*|api\.[a-z0-9.-]*anineko[a-z0-9.-]*/gi);
  console.log('domains mentioned:', [...new Set(m || [])].slice(0, 10));
}

// ---------- E. acer via corsproxy relay (search POST) ----------
async function acerRelay() {
  console.log('=== ACER relay POST test ===');
  const body = JSON.stringify({ searchQuery: 'inception' });
  // direct first (baseline from sandbox)
  const direct = await tf('https://api2.acermovies.fun/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 15000);
  console.log(`direct: ${direct.status} @${direct.ms}ms ${direct.error || ''} len=${direct.body.length}`);
  // via corsproxy.io (POST supported)
  const relay = await tf(`https://corsproxy.io/?url=${encodeURIComponent('https://api2.acermovies.fun/api/search')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 20000);
  console.log(`corsproxy: ${relay.status} @${relay.ms}ms ${relay.error || ''} len=${relay.body.length} ${relay.body.slice(0, 150).replace(/\s+/g, ' ')}`);
  // via allorigins POST (unsupported usually)
  const ao = await tf(`https://api.allorigins.win/raw?url=${encodeURIComponent('https://api2.acermovies.fun/api/search')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 20000);
  console.log(`allorigins: ${ao.status} @${ao.ms}ms ${ao.error || ''} len=${ao.body.length} ${ao.body.slice(0, 100).replace(/\s+/g, ' ')}`);
}

const secs = { driveseed, magiclinks, awiRelay, anineko, acerRelay };
const pick = process.argv[2];
for (const [k, fn] of Object.entries(secs)) {
  if (pick && k !== pick) continue;
  try { await fn(); } catch (e) { console.log(k, 'ERR', e.message); }
  if (!pick) await new Promise(r => setTimeout(r, 800));
}
