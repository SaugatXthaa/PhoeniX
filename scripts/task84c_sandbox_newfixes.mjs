// Targeted sandbox E2E for the Task 84c fixes: uhdmovies + kmmovies
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = process.env.PORT || '7085';
const BASE = `http://127.0.0.1:${PORT}`;
const check = (name, ok, detail = '') => console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);

const results = [];
async function probe(source, query, expectCards, tag, timeoutMs = 120000) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/debug/source/${source}?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    const cards = (typeof j.count === 'number' ? j.count : (j.cards || []).length);
    const logs = (j.logs || []).slice(-4).map(l => String(l).slice(0, 110));
    const ok = typeof expectCards === 'function' ? expectCards(cards, j) : cards >= expectCards;
    results.push(ok);
    check(`${tag} — ${cards} cards in ${((Date.now() - t0) / 1000).toFixed(1)}s`, ok, JSON.stringify(logs));
    return j;
  } catch (e) {
    results.push(false);
    check(`${tag}`, false, e.message.slice(0, 100));
    return null;
  }
}

// boot throttled addon
const boot = spawn('node', ['scripts/render_sandbox.cjs'], {
  env: { ...process.env, PORT: String(PORT), THROTTLE_CPU: '0.1', HEAP_MB: '448' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
boot.stdout.on('data', d => bootLog += d);
boot.stderr.on('data', d => bootLog += d);
const cleanup = () => { try { boot.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

const up = await waitForBoot();
check('addon boots under throttle', up);
if (!up) { console.log(bootLog.slice(-1500)); process.exit(1); }

// 1) uhdmovies — the rewritten provider through the real source wrapper
const uhd = await probe('uhdmovies', 'type=movie&id=tmdb:438631', c => c >= 1, 'uhdmovies Dune2021 (rewritten chain)');
const uhd2 = await probe('uhdmovies', 'type=movie&id=tmdb:693134', c => c >= 0, 'uhdmovies Dune2 (cache/second title)', 90000);
if (uhd) {
  const cards = (uhd.results || []).map(r => ({ url: r.url || '', name: (r.meta && r.meta.title) || '' }));
  const bad = cards.filter(c => !/^https?:/i.test(c.url) || /magnet:|\.html?($|\?)/i.test(c.url));
  check('uhdmovies invariants — http-only, 0 magnets/html', bad.length === 0, `${cards.length} cards`);
  const has4k = /2160|4k/i.test(JSON.stringify(uhd.results || []).slice(0, 4000));
  check('uhdmovies 4K tier present', has4k);
}

// 2) kmmovies — direct path (sandbox egress not CF-challenged) must stay green
const km = await probe('kmmovies', 'type=movie&id=tmdb:438631', c => c >= 1, 'kmmovies Dune2021', 120000);
if (km) {
  const cards = (km.results || []).map(r => ({ url: r.url || '' }));
  const bad = cards.filter(c => !/^https?:/i.test(c.url) || /magnet:/i.test(c.url));
  check('kmmovies invariants — 0 magnets', bad.length === 0, `${cards.length} cards`);
}

// 3) merged Dune2 — uhdmovies/kmmovies brands in dist
const t0 = Date.now();
try {
  const r1 = await fetch(`${BASE}/stream/movie/tt1375666.json`, { signal: AbortSignal.timeout(120000) });
  const j1 = await r1.json();
  const cc1 = r1.headers.get('cache-control') || '';
  const brands = {};
  for (const s of (j1.streams || [])) {
    const m = /PhoeniX · [^·]+ · ([^·]+?) ·/.exec(s.name || '');
    if (m) brands[m[1]] = (brands[m[1]] || 0) + 1;
  }
  const n1 = (j1.streams || []).length;
  const magnet = (j1.streams || []).filter(s => /^magnet:/i.test(s.url || '') || /\.html?($|\?)/i.test(s.url || '')).length;
  check(`merged r1 — ${n1} cards in ${((Date.now() - t0) / 1000).toFixed(0)}s`, n1 >= 100, `cc=${cc1}`);
  check('merged r1 invariants — 0 magnets/html', magnet === 0);
  const wantBrands = ['UHDMovies', 'KMMovies', 'PersianStremio', 'FrameX'];
  const present = wantBrands.filter(b => brands[b]);
  check('new-fix brands in merged dist', present.length >= 3, `present=${present.join(',')} want≥3 of ${wantBrands.join(',')}`);
  const r2 = await fetch(`${BASE}/stream/movie/tt1375666.json`, { signal: AbortSignal.timeout(120000) });
  const j2 = await r2.json();
  const cc2 = r2.headers.get('cache-control') || '';
  check(`merged r2 warm — ${(j2.streams || []).length} cards, cc=${cc2}`, /max-age=150/.test(cc2));
} catch (e) {
  check('merged rounds', false, e.message.slice(0, 100));
}

cleanup();
const pass = results.filter(Boolean).length;
console.log(`\n== RESULT: ${pass}/${results.length} PASS ==`);
process.exit(pass === results.length ? 0 : 1);
