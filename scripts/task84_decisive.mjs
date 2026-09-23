// Task 84 probe #3: decisive experiments
// A. thenaukriadda safelink trace (uhdmovies 4K posts)
// B. kmmovies hosts from PROD egress (rawfetch)
// C. acer alt-API hosts + free POST relays
// D. stellarrip encrypt step via POST relay (sandbox full chain)
import crypto from 'crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';

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

async function prodRaw(url, opts = {}) {
  const q = new URLSearchParams({ url, ...opts });
  const r = await tf(`${PROD}/debug/rawfetch?${q}`, {}, 40000);
  try { const j = JSON.parse(r.body); return { status: j.status, ms: j.ms, body: j.body || j.text || '', error: j.error }; }
  catch { return r; }
}

// ---------- A. thenaukriadda trace ----------
async function naukri() {
  console.log('=== THENAUKRIADDA safelink trace ===');
  const post = await tf('https://uhdmovies.my/download-dune-prophecy-2024-season-1-s01e01-added-dual-audio-hindi-english-2160p-4k-1080p-1080p-10bit-x264-hevc-hdr-dovi-web-dl-esubs/', { redirect: 'follow' }, 20000);
  const links = [...new Set([...post.body.matchAll(/href="(https?:\/\/en\.thenaukriadda\.in[^"]*)"/g)].map(m => m[1]))];
  console.log(`thenaukriadda links: ${links.length}`, links.slice(0, 3));
  if (!links.length) return;
  // grab surrounding anchor text to know which quality each link is
  const withText = [...post.body.matchAll(/<a[^>]+href="(https?:\/\/en\.thenaukriadda\.in[^"]*)"[^>]*>([\s\S]{0,120}?)<\/a>/g)].slice(0, 8)
    .map(m => [m[1], m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()]);
  withText.forEach(([u, t]) => console.log(`  [${t.slice(0, 60)}] ${u.slice(0, 90)}`));

  const page = await tf(links[0], { headers: { Referer: 'https://uhdmovies.my/' } }, 20000);
  console.log(`\nnaukri page: ${page.status} @${page.ms}ms len=${page.body.length} loc=${page.headers.location || ''} ${page.error || ''}`);
  if (page.body) {
    const t = page.body.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    console.log('text sample:', t.slice(0, 400));
    // look for timer / form action / sid
    const form = page.body.match(/<form[^>]*action="([^"]+)"/);
    console.log('form action:', form && form[1]);
    const timer = page.body.match(/(\d+)\s*seconds?|countdown|setTimeout\([^,]+,\s*(\d{4,5})\)/i);
    console.log('timer hint:', timer && timer[0].slice(0, 60));
    const btns = [...page.body.matchAll(/href="(https?:\/\/[^"]+)"[^>]*>(?:\s*<[^>]+>)*\s*(?:Download|Verify|Continue|Get)/gi)].map(m => m[1]).slice(0, 5);
    console.log('dl buttons:', btns);
  }
}

// ---------- B. kmmovies hosts from prod ----------
async function kmmProd() {
  console.log('=== KMMOVIES hosts from PROD egress ===');
  const r1 = await prodRaw('https://w3.magiclinks.lol/80485601-2/');
  console.log(`magiclinks: ${r1.status} @${r1.ms}ms len=${(r1.body || '').length} ${r1.error || ''}`);
  const r2 = await prodRaw('https://w1.skydrop.sbs/fetch/');
  console.log(`skydrop: ${r2.status} @${r2.ms}ms len=${(r2.body || '').length} ${r2.error || ''}`);
  const r3 = await prodRaw('https://kmmovies.rest/dune-part-two-2024-dual-audio-hindi-english-download-2160p-bluray');
  console.log(`kmmovies post: ${r3.status} @${r3.ms}ms len=${(r3.body || '').length} ${r3.error || ''}`);
}

// ---------- C. acer alt hosts + POST relays ----------
async function acer() {
  console.log('=== ACER alt API hosts ===');
  for (const h of ['api2.acermovies.fun', 'api1.acermovies.fun', 'api.acermovies.fun', 'api3.acermovies.fun']) {
    const r = await tf(`https://${h}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ searchQuery: 'dune' }) }, 12000);
    console.log(`${h}: ${r.status} @${r.ms}ms len=${r.body.length} ${r.error || ''} ${r.body.slice(0, 100).replace(/\s+/g, ' ')}`);
    await new Promise(rr => setTimeout(rr, 1200));
  }
  console.log('--- free POST relays for acer search ---');
  const target = 'https://api2.acermovies.fun/api/search';
  const body = JSON.stringify({ searchQuery: 'dune' });
  const relays = [
    ['cors.workers.dev', `https://test.cors.workers.dev/?${target}`],
    ['corsfix', `https://proxy.corsfix.com/?${target}`],
    ['cors.lol', `https://api.cors.lol/?url=${encodeURIComponent(target)}`],
  ];
  for (const [name, url] of relays) {
    const r = await tf(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://acermovies.fun', 'X-Requested-With': 'xhr' }, body }, 20000);
    console.log(`${name}: ${r.status} @${r.ms}ms len=${r.body.length} ${r.error || ''} ${r.body.slice(0, 120).replace(/\s+/g, ' ')}`);
    await new Promise(rr => setTimeout(rr, 800));
  }
}

// ---------- D. stellarrip encrypt via relay (full chain from sandbox) ----------
async function stellarRelay() {
  console.log('=== STELLARRIP encrypt-relay experiment (sandbox chain) ===');
  const BASE = 'https://stellar.rip';
  const jar = {};
  const H = { 'User-Agent': UA, 'Origin': BASE, 'Referer': `${BASE}/`, 'Accept': '*/*' };
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  function absorb(res) {
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(/,(?=[^;]+?=)/)) {
      const [kv] = part.split(';');
      const eq = kv.indexOf('=');
      if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  }
  async function call(path, opts = {}, relay = false) {
    const url = relay ? `https://test.cors.workers.dev/?${BASE}${path}` : `${BASE}${path}`;
    const headers = { ...H, ...(opts.headers || {}), Cookie: cookieHeader() };
    const t0 = Date.now();
    try {
      const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(15000) });
      absorb(res);
      const text = await res.text();
      return { status: res.status, ms: Date.now() - t0, text };
    } catch (e) { return { status: 0, ms: Date.now() - t0, text: '', error: String(e?.cause?.message || e?.message || e).slice(0, 80) }; }
  }
  // step 1: embed (headers only)
  const embed = await call('/en/watch/embed/movie/27205');
  console.log(`embed: ${embed.status} @${embed.ms}ms len=${embed.text.length} ${embed.error || ''}`);
  // step 2: request-token
  const rt = await call('/api/request-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log(`request-token: ${rt.status} @${rt.ms}ms ${rt.error || ''} len=${rt.text.length}`);
  let requestToken = '';
  try { const j = JSON.parse(rt.text); requestToken = j.token || j.requestToken || j.data?.token || ''; console.log('  token len:', requestToken.length); } catch { console.log('  body:', rt.text.slice(0, 200)); }
  if (!requestToken) { console.log('no request token — abort'); return; }
  // step 3: playback-init + PoW
  const init = await call('/api/playback-init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestToken }) });
  console.log(`playback-init: ${init.status} @${init.ms}ms ${init.error || ''} len=${init.text.length}`);
  let challenge = null;
  try { const j = JSON.parse(init.text); challenge = j.challenge || j.data?.challenge || j; } catch { console.log('  body:', init.text.slice(0, 200)); }
  if (!challenge) { console.log('no challenge — abort'); return; }
  console.log('  challenge keys:', typeof challenge === 'object' ? Object.keys(challenge) : typeof challenge);
  // solve PoW
  const ch = typeof challenge === 'string' ? JSON.parse(challenge) : challenge;
  const prefix = ch.prefix || ch.prefixSha || ch.sha || '';
  const difficulty = ch.difficulty || 18;
  let nonce = 0; const t0 = Date.now();
  if (prefix) {
    const target = '0'.repeat(Math.min(difficulty, 32));
    while (nonce < 5e7) {
      const h = crypto.createHash('sha256').update(prefix + nonce).digest('hex');
      if (h.startsWith(target)) break;
      nonce++;
    }
  }
  console.log(`  PoW solved nonce=${nonce} in ${Date.now() - t0}ms`);
  const solve = await call('/api/playback-init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestToken, nonce, prefix }) });
  console.log(`playback-solve: ${solve.status} @${solve.ms}ms ${solve.error || ''} len=${solve.text.length} ${solve.text.slice(0, 120).replace(/\s+/g, ' ')}`);
  // step 4: dead-sources
  const dead = await call('/api/dead-sources');
  console.log(`dead-sources: ${dead.status} @${dead.ms}ms ${dead.error || ''} ${dead.text.slice(0, 80)}`);
  // step 5: THE GATE — encrypt s24 via DIRECT vs RELAY
  const payload = JSON.stringify({ data: { tmdbId: '27205', type: 'movie', season: null, episode: null, server: 's24' }, endpoint: '/en/watch/embed/movie/27205', requestToken });
  const direct = await call('/api/stream-encrypted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  console.log(`encrypt DIRECT: ${direct.status} @${direct.ms}ms ${direct.error || ''} ${direct.text.slice(0, 150).replace(/\s+/g, ' ')}`);
  const relayed = await call('/api/stream-encrypted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }, true);
  console.log(`encrypt RELAY: ${relayed.status} @${relayed.ms}ms ${relayed.error || ''} ${relayed.text.slice(0, 300).replace(/\s+/g, ' ')}`);
}

const secs = { naukri, kmmProd, acer, stellarRelay };
const pick = process.env.SEC || process.argv[2];
for (const [k, fn] of Object.entries(secs)) {
  if (pick && k !== pick) continue;
  try { await fn(); } catch (e) { console.log(k, 'ERR', e.message); }
  if (!pick) await new Promise(r => setTimeout(r, 800));
}
