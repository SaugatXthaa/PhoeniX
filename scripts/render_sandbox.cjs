// render_sandbox.cjs — run the PhoeniX server under RENDER FREE TIER specs
//
// Render free instance: 512 MB RAM, 0.1 CPU (CFS bandwidth quota).
// CFS quota 0.1 CPU = the cgroup gets 10ms of runtime per 100ms period and is
// then HARD-THROTTLED (all tasks stalled) until the next period. A SIGSTOP/
// SIGCONT duty cycle on the child reproduces exactly that stall pattern.
//
// Usage: node scripts/render_sandbox.cjs
//   PORT=7070 (server port)
//   THROTTLE_CPU=0.1   (0 disables throttling — for A/B)
//   HEAP_MB=448        (--max-old-space-size; 512MB minus OS/node overhead)
//   PERIOD_MS=100      (CFS period)

'use strict';
const { spawn } = require('child_process');

const PORT = process.env.PORT || '7070';
const CPU = parseFloat(process.env.THROTTLE_CPU || '0.1');
const HEAP = process.env.HEAP_MB || '448';
const PERIOD = parseInt(process.env.PERIOD_MS || '100', 10);

const child = spawn('node', [`--max-old-space-size=${HEAP}`, 'src/index.js'], {
  env: { ...process.env, PORT },
  stdio: ['ignore', 'inherit', 'inherit'],
});

console.log(`[sandbox] pid=${child.pid} port=${PORT} cpu_quota=${CPU} heap=${HEAP}MB period=${PERIOD}ms`);

let throttling = false;
const onMs = Math.max(1, Math.round(PERIOD * CPU));
const offMs = PERIOD - onMs;

function cycle() {
  if (child.exitCode !== null) return;
  child.kill('SIGCONT'); throttling = false;
  setTimeout(() => {
    if (child.exitCode !== null) return;
    child.kill('SIGSTOP'); throttling = true;
    setTimeout(cycle, offMs);
  }, onMs);
}
if (CPU > 0) setTimeout(cycle, 2000); // let boot settle 2s, then throttle

// RSS watchdog — mirror what Render sees (512MB ceiling)
const rssTimer = setInterval(() => {
  try {
    const s = require('fs').readFileSync(`/proc/${child.pid}/status`, 'utf8');
    const rss = parseInt((s.match(/VmRSS:\s+(\d+) kB/) || [])[1] || '0', 10) / 1024;
    if (rss > 0) console.log(`[sandbox] rss=${rss.toFixed(0)}MB ${rss > 480 ? '⚠ NEAR LIMIT' : ''} ${throttling ? '(stopped)' : ''}`);
  } catch { /* exiting */ }
}, 15000);

function shutdown() {
  clearInterval(rssTimer);
  try { child.kill('SIGCONT'); } catch {}
  child.kill('SIGKILL');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', (c) => { clearInterval(rssTimer); console.log(`[sandbox] server exited code=${c}`); process.exit(c || 0); });
