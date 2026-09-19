// Task 64: download zxcprime bundles and find the new protocol
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';

const res = await fetch('https://player.zxcprime.xyz/embed/movie/27205', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
const html = await res.text();
mkdirSync('/home/z/my-project/phoenix-analysis/scripts/task64/zxc', { recursive: true });
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
console.log('scripts:', scripts.length);

for (const s of scripts) {
  const url = s.startsWith('http') ? s : 'https://player.zxcprime.xyz' + s;
  const fname = url.split('/').pop().split('?')[0];
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) continue;
    const body = await r.text();
    writeFileSync('/home/z/my-project/phoenix-analysis/scripts/task64/zxc/' + fname, body);
    const keys = ['bugok', 'sentinel', 'fToken', 'sha512', 'backend', 'encrypt'];
    const hits = keys.map(k => { const c = body.split(k).length - 1; return c ? `${k}:${c}` : null; }).filter(Boolean);
    if (hits.length) console.log(fname, body.length, '->', hits.join(' '));
  } catch (e) { }
}
