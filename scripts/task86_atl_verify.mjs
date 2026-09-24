// Task 86: verify new Atlantic protocol (Helios + Aphrodite/gate-a-new-seed) from sandbox
import crypto from 'crypto';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://atlantic.st',
  'Referer': 'https://atlantic.st/',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
};

// ---- 1. Helios: plain GET, nesterov decrypt
async function helios(tmdbId, type, season, episode) {
  const q = new URLSearchParams({ tmdbId: String(tmdbId), type });
  if (type === 'tv') { q.set('seasonId', String(season ?? 1)); q.set('episodeId', String(episode ?? 1)); }
  const t0 = Date.now();
  const r = await fetch(`https://stream.hls.lol/helios?${q}`, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  const body = await r.text();
  console.log(`[helios] ${type} ${tmdbId} → ${r.status} ${Date.now() - t0}ms len=${body.length}`);
  if (!r.ok) { console.log('  body:', body.slice(0, 150)); return; }
  const j = JSON.parse(body);
  console.log('  top keys:', Object.keys(j), '| sources:', j.sources ? Object.keys(j.sources) : 'none');
  const url = j?.sources?.Moscow?.url;
  if (!url) { console.log('  raw:', body.slice(0, 400)); return; }
  console.log('  Moscow url head:', url.slice(0, 60), url.startsWith('ns_') ? '(ns_ encrypted)' : '(plain)');
  if (!url.startsWith('ns_')) return url;
  const keyHex = 'e4b8a1d6f2c9037b5a8e4d1c6f9b2085a7c3e9f6d1b4a8c2e5f7a0d3b6c9e2f5';
  const key = Buffer.from(keyHex, 'hex');
  const blob = Buffer.from(url.slice(3), 'hex');
  const iv = blob.subarray(0, 12);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(blob.subarray(blob.length - 16));
  const plain = Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8');
  console.log('  DECRYPTED:', plain.slice(0, 120));
  return plain;
}

// ---- 2. gate a bootstrap with NEW seed
const GATE_A_SEED = '452c1208202e241c084e870ad3dffbe033c45f0e398befa3681862c84da6af19';
const VERSION = 'aphrodite.a.v1';
const masterKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(VERSION, 'utf8'), Buffer.from(GATE_A_SEED, 'hex')])).digest();

async function gateABootstrap() {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', masterKey).update(`a|${ts}|${nonce}`).digest('hex');
  const t0 = Date.now();
  const res = await fetch('https://cdn.hls.lol/content/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({ c: 'a', ts, n: nonce, s: sig }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.text();
  console.log(`[gate-a bootstrap] → ${res.status} ${Date.now() - t0}ms`);
  if (!res.ok) { console.log('  body:', body.slice(0, 100)); return null; }
  const j = JSON.parse(body);
  const blob = Buffer.from(j.d, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(blob.length - 16));
  const obj = JSON.parse(Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8'));
  console.log('  session sid=' + obj.sid + ' exp-in=' + Math.round((obj.exp - Date.now() / 1000) / 60) + 'min');
  return obj;
}

async function aphrodite(sess, path) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', Buffer.from(sess.skey, 'hex')).update(`${sess.sid}|${path}|${ts}|${nonce}`).digest('hex');
  const r = await fetch('https://cdn.hls.lol' + path, {
    headers: { 'X-A-Sid': sess.sid, 'X-A-Ts': String(ts), 'X-A-Nonce': nonce, 'X-A-Sig': sig, ...HEADERS },
    signal: AbortSignal.timeout(10000),
  });
  const body = await r.text();
  console.log(`[aphrodite] ${path} → ${r.status} len=${body.length}`);
  console.log('  body head:', body.slice(0, 250).replace(/\s+/g, ' '));
  return { status: r.status, body };
}

// Dune: Part Two (movie) + Squid Game S1E1 (tv)
const h1 = await helios(693134, 'movie');
const h2 = await helios(93405, 'tv', 1, 1);
const sess = await gateABootstrap();
if (sess) {
  await aphrodite(sess, '/content/movie/693134');
  await aphrodite(sess, '/content/tv/93405/1/1');
}
