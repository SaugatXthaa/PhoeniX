// Task 64: sweep ALL stellar.rip bundles for player/api code
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';
import { writeFileSync, readFileSync } from 'fs';

const res = await fetch(BASE + '/en/watch/movie/27205', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
const html = await res.text();
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
console.log('watch page scripts:', scripts.length);
// also collect inline scripts count
console.log('inline scripts:', (html.match(/<script(?![^>]*src=)/g) || []).length);

const seen = new Set();
for (const s of scripts) {
  if (seen.has(s)) continue;
  seen.add(s);
  const url = s.startsWith('http') ? s : BASE + s;
  const fname = s.split('/').pop();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) continue;
    const body = await r.text();
    writeFileSync('/home/z/my-project/phoenix-analysis/scripts/task64/' + fname, body);
    // Look for player-relevant code
    const keys = ['/api/encrypt', 'stream-encrypted', 'playback-init', 'playback-unavailable', 'requestToken', 'pow', 'hls', '.m3u8', 'videoUrl', 'streamUrl', 'sourceId'];
    const hits = [];
    for (const k of keys) {
      const c = body.split(k).length - 1;
      if (c) hits.push(`${k}:${c}`);
    }
    console.log(fname, body.length, '->', hits.join(' '));
  } catch (e) { console.log(fname, 'ERR', e.message); }
}
