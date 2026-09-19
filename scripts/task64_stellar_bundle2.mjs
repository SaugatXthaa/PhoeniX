// Task 64: deep-dive into the two bundles that reference encrypt/servers
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';
import { writeFileSync } from 'fs';

for (const s of ['/_next/static/chunks/1l9_u9eg6c_0j.js', '/_next/static/chunks/3322ri8o_bwx2.js', '/_next/static/chunks/40px6d9m51t2m.js', '/_next/static/chunks/4128mbzj9ieov.js']) {
  const r = await fetch(BASE + s, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  const body = await r.text();
  writeFileSync('/home/z/my-project/phoenix-analysis/scripts/task64/' + s.split('/').pop(), body);
  console.log('saved', s, body.length);
}

// quick greps on saved bundles
import { readFileSync } from 'fs';
const dir = '/home/z/my-project/phoenix-analysis/scripts/task64/';
for (const f of ['1l9_u9eg6c_0j.js', '3322ri8o_bwx2.js', '40px6d9m51t2m.js']) {
  const body = readFileSync(dir + f, 'utf-8');
  console.log('\n##########', f);
  for (const key of ['/api/encrypt', 'stream-encrypted', 'playback-unavailable', '/api/playback', 'servers', 'getSource', 'sourceList', 'stream_url']) {
    let p = 0, shown = 0;
    while (shown < 4) {
      const i = body.indexOf(key, p);
      if (i === -1) break;
      console.log(`[${key}] ...${body.slice(Math.max(0, i - 200), i + 300).replace(/\n/g, ' ')}...`);
      console.log('---');
      p = i + key.length; shown++;
    }
  }
}
