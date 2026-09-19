// Task 64: COMPLETE mfw09 chain — identity attest + captcha PoW + playback decrypt
import { webcrypto as nc } from 'crypto';
const subtle = nc.subtle;
const b64 = (buf) => Buffer.from(buf).toString('base64url');

// --- custom PoW hash (exact port) ---
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const B = 'https://mfw09.org';
const code = process.argv[2] || 'gvg3ptu77cry';
const headers = {
  'Content-Type': 'application/json',
  'X-Embed-Origin': 'https://player.zxcprime.xyz',
  'X-Embed-Referer': 'https://player.zxcprime.xyz/embed/movie/27205',
  'Origin': B,
  'Referer': 'https://player.zxcprime.xyz/',
  'User-Agent': UA,
};

// --- Step 1-4: identity attestation ---
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubJwk = await subtle.exportKey('jwk', kp.publicKey);
const priJwk = await subtle.exportKey('jwk', kp.privateKey);

const chalRes = await fetch(`${B}/api/videos/access/challenge`, { method: 'POST', headers, signal: AbortSignal.timeout(15000) });
const chal = await chalRes.json();
console.log('challenge:', chalRes.status, Object.keys(chal));

const sig = await subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, kp.privateKey, new TextEncoder().encode(chal.nonce));

const fingerprint = {
  user_agent: UA, pixel_ratio: 1, screen_width: 1920, screen_height: 1080, color_depth: 24,
  languages: ['en-US', 'en'], timezone: 'Europe/London', hardware_concurrency: 8, device_memory: 8, touch_points: 0,
  webgl_vendor: 'Google Inc. (Intel)', webgl_renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  canvas_hash: b64(await subtle.digest('SHA-256', new TextEncoder().encode('canvas-seed'))),
  audio_hash: b64(await subtle.digest('SHA-256', new TextEncoder().encode('audio-seed'))),
  webgl_params_hash: b64(await subtle.digest('SHA-256', new TextEncoder().encode('webgl-seed'))),
  fonts_hash: b64(await subtle.digest('SHA-256', new TextEncoder().encode('fonts-seed'))),
  codecs_hash: b64(await subtle.digest('SHA-256', new TextEncoder().encode('codecs-seed'))),
  media_devices: 'ai2ao3vi1', pointer_type: 'fine,hover',
  extra: { vendor: 'Google Inc.', appVersion: UA.replace('Mozilla/', '') },
};

const attestBody = {
  viewer_id: '', device_id: '',
  challenge_id: chal.challenge_id, nonce: chal.nonce,
  signature: b64(sig), public_key: pubJwk,
  client: fingerprint,
  storage: { cookie: undefined, local_storage: undefined, indexed_db: undefined, cache_storage: undefined },
  attributes: { entropy: 'medium' },
};
const attRes = await fetch(`${B}/api/videos/access/attest`, { method: 'POST', headers, body: JSON.stringify(attestBody), signal: AbortSignal.timeout(15000) });
const att = await attRes.json();
console.log('attest:', attRes.status, JSON.stringify(att).slice(0, 200));
if (!attRes.ok) process.exit(1);
const fp = { viewerId: att.viewer_id, deviceId: att.device_id, confidence: att.confidence };

// --- Step 5-7: captcha PoW ---
const cRes = await fetch(`${B}/api/videos/${code}/embed/captcha`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(15000) });
const ch = await cRes.json();
console.log('captcha diff', ch.pow_difficulty);
const solution = solvePoW(ch.pow_nonce, ch.pow_difficulty);
const vRes = await fetch(`${B}/api/videos/${code}/embed/captcha/verify`, { method: 'POST', headers, body: JSON.stringify({ pow_token: ch.pow_token, solution }), signal: AbortSignal.timeout(15000) });
const vd = await vRes.json();
console.log('verify:', vd.status);

// --- Step 8: playback with attestation + captcha token ---
const pbRes = await fetch(`${B}/api/videos/${code}/embed/playback`, {
  method: 'POST',
  headers: { ...headers, 'X-Captcha-Token': vd.token },
  body: JSON.stringify({ fingerprint: fp }),
  signal: AbortSignal.timeout(15000),
});
const pbd = await pbRes.json().catch(() => ({}));
console.log('playback:', pbRes.status, JSON.stringify(pbd).slice(0, 200));
if (!pbd.playback) process.exit(1);

// --- Step 9: AES-GCM decrypt ---
const b64d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.replace(/-/g, '+').replace(/_/g, '/').length % 4) % 4), 'base64');
const pl = pbd.playback;
const vNum = Number(pl.version);
const parts = pl.key_parts || [];
const order = (vNum >= 1 && vNum <= 20 && parts.length >= 2) ? [vNum - 1, 30 - vNum] : [0, 1];
const key = Buffer.concat(order.map(i => b64d(parts[i])));
const decipher = (await import('crypto')).createDecipheriv('aes-256-gcm', key, b64d(pl.iv));
const decrypted = Buffer.concat([decipher.update(b64d(pl.payload)), decipher.final()]);
const cfg = JSON.parse(decrypted.toString('utf-8'));
console.log('\n=== DECRYPTED CONFIG ===');
console.log(JSON.stringify(cfg, null, 1).slice(0, 2500));
