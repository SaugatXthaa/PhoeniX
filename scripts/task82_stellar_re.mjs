// Task 82 — RE stellar.rip's own browser encrypt flow: what does the real
// frontend send to /api/encrypt that our server-side copy doesn't?
// Dumps embed page SSR payload + player chunks, finds the encrypt caller.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';

const html = await (await fetch(BASE + '/en/watch/embed/movie/27205', {
  headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000),
})).text();

// 1. SSR payload check — does the embed page carry stream data directly?
console.log('=== SSR payload check ===');
const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
if (nd) {
  console.log('__NEXT_DATA__ present, ' + nd[1].length + ' bytes');
  for (const kw of ['m3u8', 'stream_url', 'heistotron', 'sources', 'playback']) {
    console.log(`  contains "${kw}": ${nd[1].includes(kw)}`);
  }
} else console.log('no __NEXT_DATA__');
for (const kw of ['heistotron', 'stream-encrypted', 'playback-unavailable', 'self.__next_f']) {
  console.log(`html contains "${kw}": ${html.includes(kw)}`);
}

// 2. player chunks — find the one calling /api/encrypt
console.log('\n=== chunk scan ===');
const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map(m => m[1]);
console.log(`${scripts.length} scripts referenced`);
let checked = 0;
for (const s of scripts) {
  if (!/chunk|player|app|pages|framework/.test(s)) continue;
  try {
    const r = await fetch(BASE + s, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) continue;
    const js = await r.text();
    checked++;
    const hits = [];
    for (const kw of ['api/encrypt', 'playback-init', 'request-token', 'playback-unavailable', 'stream-encrypted', 'dead-sources', 'pow', 'difficulty']) {
      if (js.includes(kw)) hits.push(kw);
    }
    if (hits.length) {
      console.log(`\n>> ${s} (${(js.length / 1024).toFixed(0)}KB) HITS: ${hits.join(', ')}`);
      // dump context around api/encrypt
      let idx = js.indexOf('api/encrypt');
      while (idx !== -1) {
        console.log('   ctx: ' + js.slice(Math.max(0, idx - 350), idx + 250).replace(/\s+/g, ' '));
        idx = js.indexOf('api/encrypt', idx + 1);
        if (idx > 2000000000) break;
      }
    }
  } catch { /* skip */ }
}
console.log(`\nscanned ${checked} chunks`);
