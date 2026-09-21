// Task 77 — Antarctica integration probe (scratch instance, unthrottled pass).
// 1. Boot src/index.js on a scratch port (THROTTLE_CPU=0 — fast sanity pass;
//    the throttled E2E runs separately).
// 2. Assert boot registry count (Sources: 73).
// 3. /debug/source/antarctica probes: movie (Dune 2) + series (BB S01E1).
// 4. Range-probe a REAL card URL (full=1) for playability: 206 + EBML magic.
//
// Usage: node scripts/task77_probe.mjs

import { spawn } from 'child_process';

const PORT = 7076;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn('node', ['scripts/render_sandbox.cjs'], {
  env: { ...process.env, PORT: String(PORT), THROTTLE_CPU: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
let serverPid = null;
child.stdout.on('data', d => {
  bootLog += d.toString();
  const m = bootLog.match(/\[sandbox\] pid=(\d+)/);
  if (m && !serverPid) serverPid = parseInt(m[1], 10);
});
child.stderr.on('data', d => { bootLog += d.toString(); });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

async function waitBoot(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

try {
  if (!(await waitBoot())) throw new Error('scratch instance did not boot');
  console.log('[probe] instance up on 7076 (unthrottled sanity pass)');

  const srcM = bootLog.match(/Sources: (\d+)/);
  check('boot source count = 73', srcM?.[1] === '73', `got ${srcM?.[1]}`);
  const idLine = bootLog.match(/Sources: \d+ \(([^)]*)\)/)?.[1] || '';
  check('antarctica in registry', idLine.split(',').map(s => s.trim()).includes('antarctica'));

  async function probe(type, id, label) {
    const r = await fetch(`${BASE}/debug/source/antarctica?type=${type}&id=${id}`, { signal: AbortSignal.timeout(45000) });
    const j = await r.json();
    console.log(`[probe] ${label}: count=${j.count} durationMs=${j.durationMs}`);
    (j.logs || []).slice(-4).forEach(l => console.log('   log:', l.slice(0, 120)));
    (j.results || []).slice(0, 2).forEach((res, i) => {
      const u = typeof res.url === 'string' ? res.url : res.url?.href || '';
      console.log(`   [${i}] format=${res.format} reqHdrs=${res.requestHeaders ? Object.keys(res.requestHeaders).join(',') : 'none'}`);
      console.log(`       url=${u.slice(0, 90)}`);
      console.log(`       meta.title=${(res.meta?.title || '').slice(0, 90)}`);
      console.log(`       meta.height=${res.meta?.height || '-'} countryCodes=${(res.meta?.countryCodes || []).join('/')}`);
    });
    check(`${label}: antarctica returned cards`, (j.count || 0) >= 1, `count=${j.count}`);
    return j;
  }

  const movie = await probe('movie', 'tmdb:693134', 'movie Dune2');
  await probe('series', 'tmdb:1396:1:1', 'series BBS01E1');

  // Playability probe on a REAL card URL (full=1 → 3 untruncated URLs)
  const fr = await fetch(`${BASE}/debug/source/antarctica?type=movie&id=tmdb:693134&full=1`, { signal: AbortSignal.timeout(45000) });
  const fj = await fr.json();
  const card = (fj.results || []).find(x => typeof x.url === 'string' && x.url.startsWith('http'));
  if (!card) throw new Error('no full card url available');
  const cardUrl = typeof card.url === 'string' ? card.url : card.url.href;
  console.log(`[probe] playability: Range-fetch ${cardUrl.slice(0, 70)}...`);
  const pres = await fetch(cardUrl, {
    headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36' },
    redirect: 'follow', signal: AbortSignal.timeout(25000),
  });
  const buf = Buffer.from(await pres.arrayBuffer());
  const ct = pres.headers.get('content-type') || '';
  const ar = pres.headers.get('accept-ranges') || '';
  const isMkv = buf.slice(0, 4).toString('hex') === '1a45dfa3';
  const isMp4 = buf.slice(4, 8).toString('latin1') === 'ftyp';
  console.log(`[probe] playability: status=${pres.status} ct=${ct} accept-ranges=${ar} final=${new URL(pres.url).hostname} magic=${buf.slice(0, 4).toString('hex')}`);
  check('playability: 206 + media magic (EBML/ftyp)', pres.status === 206 && (isMkv || isMp4), `status=${pres.status} mkv=${isMkv} mp4=${isMp4}`);
  check('card URL is HTTPS direct (no magnet)', cardUrl.startsWith('https://'));
  check('playability: seekable', ar === 'bytes', `accept-ranges=${ar}`);

  // meta sanity: format must be mp4 (direct), no /proxy wrap expected
  check('routing: card is DIRECT (not /proxy)', !cardUrl.includes('/proxy?'), cardUrl.slice(0, 60));
} catch (e) {
  console.log(`[probe] ❌ ${e.message}`);
  failures++;
} finally {
  if (serverPid) {
    try { process.kill(serverPid, 'SIGCONT'); } catch {}
    try { process.kill(serverPid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGCONT'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}
console.log(`[probe] RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
