// Task 64: download stellar.rip JS bundles and grep for stream/api related strings
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';

const res = await fetch(BASE + '/en', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
const html = await res.text();
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
console.log('scripts:', scripts.length);

const needles = ['stream-encrypted', 'playback', 'encrypt', 'request-token', 'playback-init', 'watch/embed', 'servers', 'source', 'm3u8', 'heistotron', 'vidlink', 'vidsrc', 'embed'];

let idx = 0;
for (const s of scripts) {
  const url = s.startsWith('http') ? s : BASE + s;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.log(`${s}: HTTP ${r.status}`); continue; }
    const body = await r.text();
    const hits = [];
    for (const n of needles) {
      let count = 0;
      let p = 0;
      while ((p = body.indexOf(n, p)) !== -1) { count++; p += n.length; if (count > 50) break; }
      if (count) hits.push(`${n}(${count})`);
    }
    if (hits.length) {
      console.log(`\n=== ${s} (${body.length}b): ${hits.join(' ')}`);
      // dump contexts around key needles
      for (const key of ['stream-encrypted', 'playback-unavailable', 'request-token', 'playback-init', '/api/encrypt', 'watch/embed']) {
        let p = 0;
        let shown = 0;
        while (shown < 3) {
          const i = body.indexOf(key, p);
          if (i === -1) break;
          console.log(`  [${key}] ...${body.slice(Math.max(0, i - 150), i + 250).replace(/\n/g, ' ')}...`);
          p = i + key.length;
          shown++;
        }
      }
    }
  } catch (e) { console.log(`${s}: ERR ${e.message}`); }
  idx++;
}
