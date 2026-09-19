// Task 64: FULL mfw09 (Byse) playback chain in Node — captcha PoW → playback → AES-GCM decrypt
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
      s = (s + d) >>> 0; s = rotl(s, 5); s = (s ^ Math.imul(d, 2246822519)) >>> 0;
    }
    n[i] = (s ^ e[2]) >>> 0;
  }
  return n;
}
function wr(t) {
  let e = 0;
  for (let r = 0; r < t.length; r++) { const n = t[r]; if (n === 0) { e += 32; continue; } return e + Math.clz32(n); }
  return e;
}
function yr(s) { const e = new Uint8Array(s.length); for (let r = 0; r < s.length; r++) e[r] = s.charCodeAt(r) & 255; return e; }
function solvePoW(nonce, difficulty, maxMs = 25000) {
  const prefix = nonce + ':';
  const t0 = Date.now();
  let s = 0;
  for (;;) {
    for (let c = 0; c < 1024; c++) {
      if (wr(gr(yr(prefix + s))) >= difficulty) return String(s);
      s++;
    }
    if (Date.now() - t0 > maxMs) return null;
  }
}
function b64u(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 === 0 ? 0 : 4 - t.length % 4;
  return Buffer.from(t + '='.repeat(pad), 'base64');
}
function keyOrder(version, count) {
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1 || v > 20) return null;
  const a = v, b = 31 - v;
  if (a < 1 || b < 1 || a > count || b > count) return null;
  return [a, b];
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const code = process.argv[2] || 'gvg3ptu77cry';
const headers = {
  'Content-Type': 'application/json',
  'X-Embed-Origin': 'https://player.zxcprime.xyz',
  'X-Embed-Referer': 'https://player.zxcprime.xyz/embed/movie/27205',
  'Origin': 'https://mfw09.org',
  'Referer': 'https://player.zxcprime.xyz/',
  'User-Agent': UA,
};
const B = 'https://mfw09.org';

const r = await fetch(`${B}/api/videos/${code}/embed/captcha`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(15000) });
const ch = await r.json();
console.log('challenge:', r.status, 'diff', ch.pow_difficulty);
const t0 = Date.now();
const solution = solvePoW(ch.pow_nonce, ch.pow_difficulty);
console.log('solved in', Date.now() - t0, 'ms');
const v = await fetch(`${B}/api/videos/${code}/embed/captcha/verify`, { method: 'POST', headers, body: JSON.stringify({ pow_token: ch.pow_token, solution }), signal: AbortSignal.timeout(15000) });
const vd = await v.json();
console.log('verify:', vd.status, 'expires_in', vd.expires_in);
if (vd.status !== 'ok') process.exit(1);

let pb = await fetch(`${B}/api/videos/${code}/embed/playback`, { headers: { ...headers, 'X-Captcha-Token': vd.token }, signal: AbortSignal.timeout(15000) });
if (pb.status === 405) {
  pb = await fetch(`${B}/api/videos/${code}/embed/playback`, { method: 'POST', headers: { ...headers, 'X-Captcha-Token': vd.token }, body: JSON.stringify({}), signal: AbortSignal.timeout(15000) });
}
const pbd = await pb.json();
console.log('playback:', pb.status, 'keys:', Object.keys(pbd), 'playback keys:', pbd.playback ? Object.keys(pbd.playback) : null);

const pl = pbd.playback;
if (pl) {
  const order = keyOrder(pl.version, (pl.key_parts || []).length);
  console.log('version', pl.version, 'key_parts', (pl.key_parts || []).length, 'order', order);
  const parts = (pl.key_parts || []);
  const ordered = order ? [parts[order[0] - 1], parts[order[1] - 1]] : parts;
  const key = Buffer.concat(ordered.map(b64u));
  const iv = b64u(pl.iv);
  const data = b64u(pl.payload);
  const { createDecipheriv } = await import('crypto');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  // node needs the tag — GCM tag is appended? The browser decrypt just uses payload (WebCrypto includes tag at end)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  const cfg = JSON.parse(decrypted.toString('utf-8'));
  console.log('\n=== DECRYPTED CONFIG ===');
  console.log(JSON.stringify(cfg, null, 1).slice(0, 2500));
}
