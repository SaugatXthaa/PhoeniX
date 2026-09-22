// Task 82 — throttled sandbox E2E, single-command lifecycle (boot → checks → cleanup).
// Run: node scripts/task82_sandbox_e2e.mjs   (no pipes — output must stream)
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
  env: { ...process.env, PORT: '7082', THROTTLE_CPU: '0.1', HEAP_MB: '448' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
wrapper.stdout.on('data', d => {
  bootLog += d.toString();
  const m = bootLog.match(/\[sandbox\] pid=(\d+)/);
  if (m && !serverPid) serverPid = parseInt(m[1], 10);
});
wrapper.stderr.on('data', d => { bootLog += d.toString(); });

const BASE = 'http://127.0.0.1:7082';

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
  const r = await fetch(`${BASE}/debug/source/${sourceId}?type=${type}&id=tmdb:${tmdb}`, { signal: AbortSignal.timeout(90000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function mergedRound(type, id) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/${type}/${id}.json`, { signal: AbortSignal.timeout(120000) });
  const cc = r.headers.get('cache-control') || '';
  const j = await r.json().catch(() => ({ streams: [] }));
  return { cc, streams: j.streams || [], dt: ((Date.now() - t0) / 1000).toFixed(1) };
}

try {
  // wait for the wrapper's pid line (stdout delivery is async)
  for (let i = 0; i < 40 && !serverPid; i++) await new Promise(r => setTimeout(r, 250));
  if (!serverPid) throw new Error('no sandbox pid line in boot log');
  const booted = await waitBoot();
  if (!booted) throw new Error('sandbox did not boot in 300s (log tail: ' + bootLog.slice(-200) + ')');
  console.log('[e2e] sandbox up (0.1 CPU / 448MB) @ ' + execSync('git rev-parse --short HEAD').toString().trim());

  // 1. registry
  {
    const r = await fetch(BASE + '/debug/source/__nonexistent__');
    const j = await r.json().catch(() => ({}));
    const avail = j.error || '';
    check('registry: stellarrip registered', avail.includes('stellarrip'));
    check('registry: antarctica present', avail.includes('antarctica'));
  }

  // 2. stellarrip chain progression (site windows decide cards; WE control
  //    chain progression inside the race)
  {
    const { body } = await dbgSource('stellarrip', 693134, 'movie');
    const logs = (body?.logs || []).map(l => String(l)).join(' | ');
    console.log('  [info] stellarrip logs: ' + (logs.slice(0, 400) || '(empty)'));
    const tokensOk = logs.includes('Request token acquired') && logs.includes('Stream token acquired');
    const chainTimeout = /aborted due to timeout/.test(logs);
    const n = (body?.streams || []).length;
    check('stellarrip Dune2: chain reaches sweep (tokens acquired)', tokensOk, `cards=${n} durationMs=${body?.durationMs}`);
    check('stellarrip Dune2: no chain-killing timeout', !chainTimeout, chainTimeout ? 'TIMEOUT IN LOGS' : 'clean');
    if (n > 0) {
      const urls = (body.streams || []).map(s => s.url || '');
      check('stellarrip Dune2: all URLs https', urls.every(u => u.startsWith('https://')), `${urls.length} urls`);
    }
  }

  // 3. merged rounds sanity
  {
    const r1 = await mergedRound('movie', 'tmdb:693134');
    const html = r1.streams.filter(s => /\.html?($|\?)/i.test(s.url || '')).length;
    const magnets = r1.streams.filter(s => /^magnet:/i.test(s.url || '')).length;
    check('merged Dune2 r1: healthy card count', r1.streams.length >= 60, `total=${r1.streams.length} @${r1.dt}s`);
    check('merged Dune2 r1: 0 magnets / 0 html', magnets === 0 && html === 0, `m=${magnets} h=${html}`);
    const r2 = await mergedRound('movie', 'tmdb:693134');
    check('merged Dune2 r2 warm: converged-or-growing', r2.streams.length >= r1.streams.length, `r2=${r2.streams.length} @${r2.dt}s`);
    const r3 = await mergedRound('movie', 'tmdb:693134');
    check('merged Dune2 r3: cc max-age=150', /max-age=150/.test(r3.cc), `cc="${r3.cc}" total=${r3.streams.length} @${r3.dt}s`);
  }
} catch (e) {
  check('e2e harness', false, e.message);
} finally {
  cleanup();
}

const fails = results.filter(r => !r.ok).length;
console.log(`\n=== RESULT: ${results.length - fails} PASS / ${fails} FAIL ===`);
process.exit(fails > 0 ? 1 : 0);
