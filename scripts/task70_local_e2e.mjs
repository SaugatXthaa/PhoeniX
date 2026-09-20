// Task 70 local E2E: boot the addon, resolve a cold movie title twice, verify
// the named sources (4khdhub / desiflix / peckle) + 4K presence + no html.
import { spawn } from 'child_process';

const PORT = 7100;
const BASE = `http://127.0.0.1:${PORT}`;
const proc = spawn('node', ['src/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let bootLog = '';
proc.stdout.on('data', c => bootLog += c);
proc.stderr.on('data', c => bootLog += c);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitBoot() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/manifest.json`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function summarize(json, label) {
  const d = json;
  const f = n => d.streams.filter(s => new RegExp(n, 'i').test(s.title || '')).length;
  const k4 = d.streams.filter(s => /2160|\b4K\b/i.test(s.title || '')).length;
  const html = d.streams.filter(s => /^https?:\/\/[^/]+\/?(?:\?.*)?$/.test(s.url || '') && !/m3u8|mp4|mkv|\.(ts|mpd)/i.test(s.url || '')).length;
  console.log(`${label}: total=${d.streams.length} | 4khdhub=${f('4KHDHub')} | 2Peckle=${f('2Peckle')} | DesiFlix=${f('DesiFlix')} | UHD=${f('UHD')} | VixSrc=${f('VixSrc')} | 4K=${k4} | htmlSUSPECT=${html}`);
}

async function main() {
  if (!await waitBoot()) { console.error('BOOT FAILED\n' + bootLog.slice(-2000)); process.exit(1); }
  console.log('boot OK');

  // Cold movie (Inside Out 2 — the title that failed in production)
  const t0 = Date.now();
  let r = await fetch(`${BASE}/stream/movie/tmdb:1022789.json`);
  let d = await r.json();
  summarize(d, `movie r1 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const t1 = Date.now();
  r = await fetch(`${BASE}/stream/movie/tmdb:1022789.json`);
  d = await r.json();
  summarize(d, `movie r2 (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  // Series sanity (no regressions): Breaking Bad S01E01
  const t2 = Date.now();
  r = await fetch(`${BASE}/stream/series/tmdb:1396:1:1.json`);
  d = await r.json();
  summarize(d, `series BB r1 (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

  // Card-shape check: desiflix/vixsrc must be direct+proxyHeaders (player-IP)
  for (const name of ['DesiFlix', 'VixSrc', '2Peckle']) {
    const cards = d.streams.filter(s => new RegExp(name, 'i').test(s.title || ''));
    if (cards.length) {
      const c = cards[0];
      console.log(`  ${name} card: url=${(c.url || '').slice(0, 70)} hints=${JSON.stringify(c.behaviorHints || {})}`);
    }
  }

  proc.kill('SIGKILL');
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); proc.kill('SIGKILL'); process.exit(1); });
