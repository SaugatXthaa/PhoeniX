// Task 84 — throttled sandbox E2E for the three source fixes (single-command lifecycle).
// Run: node scripts/task84_sandbox_e2e.mjs
import { spawn, execSync } from 'child_process';

process.on('SIGTERM', () => { cleanup(); process.exit(2); });
process.on('SIGINT', () => { cleanup(); process.exit(2); });

let wrapper = null, serverPid = null;
function cleanup() {
  if (serverPid) { try { execSync(`kill -CONT ${serverPid} 2>/dev/null; kill -9 ${serverPid} 2>/dev/null`); } catch { /* gone */ } }
  if (wrapper && wrapper.exitCode === null) { try { wrapper.kill('SIGKILL'); } catch { /* gone */ } }
}

const results = [];
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ ok });
};

wrapper = spawn('node', ['scripts/render_sandbox.cjs'], {
  env: { ...process.env, PORT: '7083', THROTTLE_CPU: '0.1', HEAP_MB: '448' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
wrapper.stdout.on('data', d => {
  bootLog += d.toString();
  const m = bootLog.match(/\[sandbox\] pid=(\d+)/);
  if (m && !serverPid) serverPid = parseInt(m[1], 10);
});
wrapper.stderr.on('data', d => { bootLog += d.toString(); });

const BASE = 'http://127.0.0.1:7083';

async function waitBoot(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/manifest.json', { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* booting */ }
    await new Promise(r => setTimeout(r, 2500));
  }
  return false;
}

async function dbgSource(sourceId, tmdb, type = 'movie') {
  const r = await fetch(`${BASE}/debug/source/${sourceId}?type=${type}&id=tmdb:${tmdb}`, { signal: AbortSignal.timeout(100000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function mergedRound(type, id) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { signal: AbortSignal.timeout(130000) });
  const cc = r.headers.get('cache-control') || '';
  const j = await r.json().catch(() => ({ streams: [] }));
  return { cc, streams: j.streams || [], dt: ((Date.now() - t0) / 1000).toFixed(1) };
}

const brandDist = (streams) => {
  const dist = {};
  for (const s of streams) {
    const m = /PhoeniX · [^·]+ · ([^·]+?) ·/.exec(s.name || '');
    const b = m ? m[1].trim() : 'other';
    dist[b] = (dist[b] || 0) + 1;
  }
  return dist;
};

try {
  process.stdout.write('[*] booting throttled addon (0.1 CPU / 448MB)...\n');
  const booted = await waitBoot();
  check('addon boots under throttle', booted);
  if (!booted) { console.log(bootLog.slice(-3000)); throw new Error('no boot'); }

  // 1. registry
  const reg404 = await (await fetch(BASE + '/debug/source/nonexistent-src?type=movie&id=tmdb:1')).json();
  const avail = String(reg404?.error || '');
  const regCount = avail.includes('Available:') ? avail.split('Available:')[1].split(',').filter(Boolean).length : 0;
  check('registry complete', regCount >= 73 && !/dahmermovies|antova|cuevana/.test(avail), `${regCount} sources`);

  // 2. FRAMEXTV isolated — the transport flip
  process.stdout.write('[*] probing framextv...\n');
  const fx = await dbgSource('framextv', 693134);
  const fxCards = (fx.body?.streams || fx.body?.results || []).length;
  check('framextv delivers from sandbox', fxCards >= 1, `${fxCards} cards in ${fx.body?.durationMs}ms — ${JSON.stringify((fx.body?.streams || [])[0]?.name || '').slice(0, 70)}`);

  // 3. PERSIANSTREMIO isolated — the 25s budget rewrite
  process.stdout.write('[*] probing persianstremio...\n');
  const ps = await dbgSource('persianstremio', 27205);
  const psCards = (ps.body?.streams || ps.body?.results || []).length;
  check('persianstremio delivers from sandbox', psCards >= 3, `${psCards} cards in ${ps.body?.durationMs}ms`);

  // 4. ACERMOVIES — force cooldown to exercise the relay path
  process.stdout.write('[*] probing acermovies (relay path)...\n');
  // Two calls: first may engage the cooldown (429 via direct), second exercises relay.
  const ac1 = await dbgSource('acermovies', 27205);
  const ac2 = await dbgSource('acermovies', 27205);
  const ac2Cards = (ac2.body?.streams || ac2.body?.results || []).length;
  const acLog = JSON.stringify(ac2.body?.logs || ac2.body?.logTail || '');
  const relayEngaged = /relay/.test(acLog);
  check('acermovies responds (relay or direct)', ac2.status === 200, `run2: ${ac2Cards} cards, relayEngaged=${relayEngaged}, log=${acLog.slice(0, 160)}`);

  // 5. MERGED Dune2 convergence + invariants
  process.stdout.write('[*] merged Dune2 r1 (cold)...\n');
  const r1 = await mergedRound('movie', 'tt1375666');
  const noMagnet1 = r1.streams.every(s => !/^magnet:/i.test(s.url || ''));
  const noHtml1 = r1.streams.every(s => !/\.html?($|\?)/i.test(s.url || ''));
  check('merged r1 invariants', noMagnet1 && noHtml1, `${r1.streams.length} cards cc=${r1.cc} ${r1.dt}s`);
  process.stdout.write('[*] merged Dune2 r2 (warm)...\n');
  const r2 = await mergedRound('movie', 'tt1375666');
  const dist = brandDist(r2.streams);
  const fourK = r2.streams.filter(s => /2160|4K/i.test(s.name || '')).length;
  const noMagnet2 = r2.streams.every(s => !/^magnet:/i.test(s.url || ''));
  const noHtml2 = r2.streams.every(s => !/\.html?($|\?)/i.test(s.url || ''));
  check('merged r2 warm + converged cc', r2.streams.length >= r1.streams.length && /max-age=150/.test(r2.cc),
    `${r2.streams.length} cards (r1 ${r1.streams.length}) cc=${r2.cc}`);
  check('4K present', fourK >= 30, `${fourK} 4K cards`);
  check('invariants r2', noMagnet2 && noHtml2, `magnets/html=0, brands=${Object.keys(dist).length}`);

  // 6. FrameX/Persian cards present in merged?
  const fxDist = Object.entries(dist).filter(([k]) => /FrameX|PersianStremio/i.test(k));
  console.log('  brand spot:', JSON.stringify(fxDist), '| acer:', dist['AcerMovies'] || 0);

  const pass = results.filter(r => r.ok).length;
  console.log(`\n== RESULT: ${pass}/${results.length} PASS ==`);
  process.exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  console.log('HARNESS ERR:', e.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
