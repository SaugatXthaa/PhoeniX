// Task 70: verify desiflix/vixsrc cards ship direct-with-headers end-to-end.
import { spawn } from 'child_process';
const PORT = 7101;
const BASE = `http://127.0.0.1:${PORT}`;
const proc = spawn('node', ['src/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let bootLog = '';
proc.stdout.on('data', c => bootLog += c);
proc.stderr.on('data', c => bootLog += c);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/manifest.json`); if (r.ok) break; } catch {} await sleep(500); }
  const r = await fetch(`${BASE}/stream/movie/tmdb:872585.json`, { signal: AbortSignal.timeout(120000) });
  const d = await r.json();
  for (const name of ['DesiFlix', 'VixSrc']) {
    const cards = d.streams.filter(s => new RegExp(name, 'i').test(s.title || ''));
    console.log(`${name}: ${cards.length} card(s)`);
    for (const c of cards.slice(0, 2)) {
      console.log('  url:', (c.url || '').slice(0, 95));
      console.log('  hints:', JSON.stringify(c.behaviorHints || {}));
    }
  }
  proc.kill('SIGKILL');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e?.message || e); console.log(bootLog.slice(-1500)); proc.kill('SIGKILL'); process.exit(1); });
