// Task 86d: RE player.zxcprime.xyz — new token protocol for zxcstream
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
import fs from 'fs';

async function get(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: opts.referer || 'https://player.zxcprime.xyz/', ...(opts.headers || {}) },
    redirect: opts.manual ? 'manual' : 'follow',
    signal: AbortSignal.timeout(15000),
    method: opts.method || 'GET',
    body: opts.body,
  });
  const body = await res.text();
  console.log(`[get] ${url} → ${res.status} len=${body.length}`);
  return { status: res.status, body };
}

// 1. embed page for Inception (movie)
const embed = await get('https://player.zxcprime.xyz/embed/movie/27205', { referer: 'https://player.zxcstream.xyz/' });
fs.writeFileSync('/tmp/zxc_embed.html', embed.body);
// look for backend/token/keys
for (const pat of [/backend[^"'\s]*/g, /token[^"'\s]{0,30}/gi, /[a-z_]*key[a-z_]*/gi, /fetch\([^)]*\)/g, /\.php[^"'\s]*/g, /\/api\/[^"'\s]*/g]) {
  const ms = [...new Set((embed.body.match(pat) || []).map(x => x.slice(0, 60)))];
  if (ms.length) console.log('  pat', pat, '→', ms.slice(0, 12));
}
console.log('--- head 600:', embed.body.slice(0, 600).replace(/\s+/g, ' '));
