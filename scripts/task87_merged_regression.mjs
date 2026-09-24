// Task 87: merged-flow regression — one Inception round through the real /stream endpoint.
const REPO = '/home/z/my-project/phoenix-analysis';
const PORT = '4601';
const BASE = `http://127.0.0.1:${PORT}`;
import { spawn } from 'node:child_process';

const child = spawn('node', ['src/index.js'], { cwd: REPO, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', () => { });
child.stderr.on('data', () => { });

const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) break; } catch { }
  await new Promise(r => setTimeout(r, 1500));
}
console.log('booted, running merged round (up to 75s)...');

const t0 = Date.now();
const r = await fetch(`${BASE}/stream/movie/tmdb:27205.json`, { signal: AbortSignal.timeout(75000) });
const j = await r.json().catch(() => ({ streams: [] }));
const dt = ((Date.now() - t0) / 1000).toFixed(1);
const streams = j.streams || [];
const cc = r.headers.get('cache-control');

const magnets = streams.filter(s => /^magnet:/i.test(s.url || '') || /^magnet:/i.test(s.externalUrl || ''));
const htmlUrls = streams.filter(s => /\.html?(?:$|[?#])/i.test(s.url || '') || /\.html?(?:$|[?#])/i.test(s.externalUrl || ''));
const acers = streams.filter(s => s.behaviorFlags?.cached || (s.name || '').includes('Acer'));
const brands = new Set(streams.map(s => { const m = (s.title || '').match(/PhoeniX ·([^·]*)·([^·]*)·/); return m ? m[1].trim() : '?'; }));

console.log(`merged Inception: ${streams.length} cards in ${dt}s | cc="${cc}"`);
console.log(`4K(2160): ${streams.filter(s => s.title?.includes('4K') || s.description?.match(/2160|4K/)).length} | brands: ${brands.size}`);
console.log(`magnets: ${magnets.length} | html urls: ${htmlUrls.length} | acer present: ${acers.length}`);
console.log('brand sample:', [...brands].slice(0, 25).join(', '));
child.kill('SIGKILL');
const ok = streams.length >= 80 && magnets.length === 0 && htmlUrls.length === 0;
console.log(ok ? '\nREGRESSION CHECK PASS' : '\nREGRESSION CHECK FAIL');
process.exit(ok ? 0 : 1);
