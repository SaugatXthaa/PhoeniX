// Task 67: local E2E — animotvslash cards must SURVIVE the streamGate on the
// merged /stream path (nexabloom-ipclass-gate verdict) + subtitle coverage +
// zero html cards. Boots the addon on :4699 and probes JJK S1E1.
import { spawn } from 'child_process';

const PORT = 4699;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn('node', ['src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
child.stdout.on('data', d => { bootLog += d; });
child.stderr.on('data', d => { bootLog += d; });

async function waitBoot() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

const up = await waitBoot();
if (!up) { console.log('BOOT FAILED\n' + bootLog.slice(-1500)); child.kill(); process.exit(1); }
console.log('server up on', PORT);

try {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/stream/series/tmdb:95479:1:1.json`, { signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => null);
  const cards = j?.streams || [];
  console.log(`JJK S1E1 merged: ${cards.length} cards in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const animo = cards.filter(c => /animotv/i.test(c.name || ''));
  console.log('AniMoTVSlash cards:', animo.length);
  for (const c of animo) {
    console.log('  -', (c.name || '').slice(0, 50), '| subs:', (c.subtitles || []).length, '|', (c.url || '').slice(0, 95));
  }
  const htmlCards = cards.filter(c => /^\s*<(!!doctype|html)/i.test(c.url || ''));
  console.log('html-url cards:', htmlCards.length);
  const subbed = cards.filter(c => (c.subtitles || []).length > 0).length;
  console.log(`subtitle coverage: ${subbed}/${cards.length}`);
} finally {
  child.kill('SIGKILL');
  process.exit(0);
}
