// Task 64: playback POST with realistic fingerprint + X-Captcha-Token
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
  for (let i = 0; i < 8; i++) {
    ye(e);
    let s = e[0];
    const a = i * 64;
    for (let c = 0; c < 64; c++) {
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
const { createHash } = await import('crypto');
function h(s) { return createHash('sha256').update(s).digest('hex'); }
function solvePoW(nonce, difficulty, maxMs = 25000) {
  let s = 0;
  const t0 = Date.now();
  for (;;) {
    const str = nonce + ':' + s;
    const a = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 255;
    if (wr(gr(a)) >= difficulty) return String(s);
    s++;
    if (Date.now() - t0 > maxMs) return null;
  }
}
function b64u(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 === 0 ? 0 : 4 - t.length % 4;
  return Buffer.from(t + '='.repeat(pad), 'base64');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const code = process.argv[2] || 'gvg3ptu77cry';
const B = 'https://mfw09.org';
const headers = {
  'Content-Type': 'application/json',
  'X-Embed-Origin': 'https://player.zxcprime.xyz',
  'X-Embed-Referer': 'https://player.zxcprime.xyz/embed/movie/27205',
  'Origin': B,
  'Referer': 'https://player.zxcprime.xyz/',
  'User-Agent': UA,
};

const fingerprint = {
  user_agent: UA,
  pixel_ratio: 1,
  screen_width: 1920, screen_height: 1080, color_depth: 24,
  languages: ['en-US', 'en'],
  timezone: 'Europe/London',
  hardware_concurrency: 8, device_memory: 8, touch_points: 0,
  webgl_vendor: 'Google Inc. (Intel)', webgl_renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  canvas_hash: h('canvas-sample'), audio_hash: h('audio-sample'), webgl_params_hash: h('webgl-sample'),
  fonts_hash: h('fonts-sample'), codecs_hash: h('codecs-sample'),
  media_devices: 'ai2ao3vi1',
  pointer_type: 'fine,hover',
  extra: { vendor: 'Google Inc.', appVersion: UA.replace('Mozilla/', '') },
};

const r = await fetch(`${B}/api/videos/${code}/embed/captcha`, { method: 'POST', headers, body: JSON.stringify({ fingerprint }), signal: AbortSignal.timeout(15000) });
const ch = await r.json();
console.log('challenge diff', ch.pow_difficulty);
const solution = solvePoW(ch.pow_nonce, ch.pow_difficulty);
console.log('solved');
const v = await fetch(`${B}/api/videos/${code}/embed/captcha/verify`, { method: 'POST', headers, body: JSON.stringify({ pow_token: ch.pow_token, solution, fingerprint }), signal: AbortSignal.timeout(15000) });
const vd = await v.json();
console.log('verify:', vd.status);

const pb = await fetch(`${B}/api/videos/${code}/embed/playback`, {
  method: 'POST',
  headers: { ...headers, 'X-Captcha-Token': vd.token },
  body: JSON.stringify({ fingerprint }),
  signal: AbortSignal.timeout(15000),
});
const pbd = await pb.json().catch(() => ({}));
console.log('playback:', pb.status, JSON.stringify(pbd).slice(0, 300));

if (pbd.playback) {
  const pl = pbd.playback;
  const vNum = Number(pl.version);
  const parts = pl.key_parts || [];
  const order = (vNum >= 1 && vNum <= 20 && parts.length >= 2) ? [vNum - 1, 30 - vNum] : [0, 1];
  const key = Buffer.concat(order.map(i => b64u(parts[i])));
  const { createDecipheriv } = await import('crypto');
  const decipher = createDecipheriv('aes-256-gcm', key, b64u(pl.iv));
  const decrypted = Buffer.concat([decipher.update(b64u(pl.payload)), decipher.final()]);
  const cfg = JSON.parse(decrypted.toString('utf-8'));
  console.log('\n=== DECRYPTED ===');
  console.log(JSON.stringify(cfg, null, 1).slice(0, 2200));
}
