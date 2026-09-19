// Task 64: mfw09 (Byse) PoW + playback flow in Node
// exact port of the bundle: yr (utf8 bytes), ye (4-word mix), gr (custom hash), wr (leading zero bits)
function rotl(x, e) { return (x << e | x >>> (32 - e)) >>> 0; }
function ye(t) {
  t[0] = (t[0] + t[1]) >>> 0; t[3] = rotl(t[3] ^ t[0], 16);
  t[2] = (t[2] + t[3]) >>> 0; t[1] = rotl(t[1] ^ t[2], 12);
  t[0] = (t[0] + t[1]) >>> 0; t[3] = rotl(t[3] ^ t[0], 8);
  t[2] = (t[2] + t[3]) >>> 0; t[1] = rotl(t[1] ^ t[2], 7);
}
function gr(t) {
  const e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < t.length; i++) { e[0] = (e[0] + t[i]) >>> 0; e[0] = rotl(e[0], 7); ye(e); }
  for (let i = 0; i < 8; i++) ye(e);
  const r = new Uint32Array(512);
  for (let i = 0; i < 512; i++) { ye(e); r[i] = (e[0] ^ e[2]) >>> 0; }
  for (let i = 0; i < 2; i++)
    for (let s = 0; s < 512; s++) {
      const a = r[s] & 511;
      let c = (r[s] + r[a]) >>> 0;
      c = rotl(c, 13);
      c = (c ^ Math.imul(r[(s + 1) & 511], 2654435761)) >>> 0;
      r[s] = c;
      e[0] = (e[0] ^ c) >>> 0;
      ye(e);
    }
  const n = new Uint32Array(8);
  const o = 512 / 8;
  for (let i = 0; i < 8; i++) {
    ye(e);
    let s = e[0];
    const a = i * o;
    for (let c = 0; c < o; c++) {
      const d = r[a + c];
      s = (s + d) >>> 0;
      s = rotl(s, 5);
      s = (s ^ Math.imul(d, 2246822519)) >>> 0;
    }
    n[i] = (s ^ e[2]) >>> 0;
  }
  return n;
}
function wr(t) {
  let e = 0;
  for (let r = 0; r < t.length; r++) {
    const n = t[r];
    if (n === 0) { e += 32; continue; }
    return e + Math.clz32(n);
  }
  return e;
}
function yr(s) { const e = new Uint8Array(s.length); for (let r = 0; r < s.length; r++) e[r] = s.charCodeAt(r) & 255; return e; }

function solvePoW(token, difficulty, maxMs = 20000) {
  if (difficulty <= 0) return '0';
  const prefix = token + ':';
  const t0 = Date.now();
  let s = 0;
  for (;;) {
    for (let c = 0; c < 1024; c++) {
      const d = gr(yr(prefix + s));
      if (wr(d) >= difficulty) return String(s);
      s++;
    }
    if (Date.now() - t0 > maxMs) return null;
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const code = process.argv[2] || 'gvg3ptu77cry';
const headers = {
  'Content-Type': 'application/json',
  'X-Embed-Origin': 'https://player.zxcprime.xyz',
  'X-Embed-Referer': 'https://player.zxcprime.xyz/embed/movie/27205',
  'X-Embed-Parent': 'https://player.zxcprime.xyz',
  'Origin': 'https://mfw09.org',
  'Referer': 'https://player.zxcprime.xyz/',
  'User-Agent': UA,
};

const r = await fetch(`https://mfw09.org/api/videos/${code}/embed/captcha`, { method: 'POST', headers, body: JSON.stringify({}), signal: AbortSignal.timeout(15000) });
const ch = await r.json();
console.log('challenge:', r.status, 'difficulty', ch.pow_difficulty, 'algorithm', ch.algorithm);

const t0 = Date.now();
const solution = solvePoW(ch.pow_nonce, ch.pow_difficulty);  // solver input = pow_nonce (bundle: no(A.nonce, A.difficulty, H))
console.log('solution:', solution, 'in', Date.now() - t0, 'ms');
if (!solution) process.exit(1);

const v = await fetch(`https://mfw09.org/api/videos/${code}/embed/captcha/verify`, {
  method: 'POST', headers, body: JSON.stringify({ pow_token: ch.pow_token, solution }), signal: AbortSignal.timeout(15000),
});
const vd = await v.json();
console.log('verify:', v.status, JSON.stringify(vd));

if (vd.token) {
  // find the playlist: try common paths
  for (const p of [
    `/api/videos/${code}/embed/file?token=${vd.token}`,
    `/api/videos/${code}/embed/playlist?token=${vd.token}`,
    `/api/videos/stream/${vd.token}`,
    `/api/videos/${code}/embed?token=${vd.token}`,
    `/api/videos/${code}/file?token=${vd.token}`,
  ]) {
    try {
      const fr = await fetch('https://mfw09.org' + p, { headers: { ...headers, 'Content-Type': undefined }, signal: AbortSignal.timeout(12000) });
      const t = await fr.text();
      console.log(p.slice(0, 60), '->', fr.status, '::', t.slice(0, 180).replace(/\n/g, ' '));
      if (fr.status === 200 && (t.includes('m3u8') || t.includes('mp4') || t.includes('sources'))) {
        console.log('FULL:', t.slice(0, 1200));
        break;
      }
    } catch (e) { console.log(p.slice(0, 60), 'ERR', e.message.slice(0, 60)); }
  }
}
