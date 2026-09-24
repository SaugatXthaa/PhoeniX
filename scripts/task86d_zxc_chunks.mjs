// Task 86d part 2: pull all zxcprime chunks, grep for API routes + stream logic
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
import fs from 'fs';

const s = fs.readFileSync('/tmp/zxc_embed.html', 'utf8');
const js = [...new Set([...s.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9._%-]+\.js/g)].map(m => m[0]))];
console.log('chunks:', js.length);
fs.mkdirSync('/tmp/zxc_chunks', { recursive: true });
let found = [];
for (const c of js) {
  const name = c.split('/').pop();
  try {
    const r = await fetch('https://player.zxcprime.xyz' + c, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.log(name, r.status); continue; }
    const body = await r.text();
    fs.writeFileSync('/tmp/zxc_chunks/' + name, body);
    // search for route patterns
    const pats = [
      [/["'`](\/api\/[^"'`]{2,60})["'`]/g, 'api'],
      [/["'`](\/backend\/[^"'`]{2,60})["'`]/g, 'backend'],
      [/["'`](\/embed\/[^"'`]{2,60})["'`]/g, 'embed'],
      [/["'`](https?:\/\/[^"'`]*(?:m3u8|mp4|embed|stream|player|video)[^"'`]{0,40})["'`]/g, 'streamurl'],
      [/["'`](\/[a-z0-9_-]{4,30}\/(?:watch|token|source|get|play|info)[^"'`]{0,40})["'`]/g, 'route'],
    ];
    for (const [pat, tag] of pats) {
      const ms = [...new Set([...body.matchAll(pat)].map(m => m[1]))];
      if (ms.length) found.push([name, tag, ms.slice(0, 10)]);
    }
  } catch (e) { console.log(name, 'FAIL', e.message.slice(0, 40)); }
}
for (const [name, tag, ms] of found) {
  console.log(`== ${name} [${tag}]`);
  ms.forEach(m => console.log('   ' + m));
}
