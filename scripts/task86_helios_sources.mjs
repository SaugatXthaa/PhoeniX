import crypto from 'crypto';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': 'https://atlantic.st', 'Referer': 'https://atlantic.st/', 'Accept': '*/*',
};
function dec(ns) {
  const key = Buffer.from('e4b8a1d6f2c9037b5a8e4d1c6f9b2085a7c3e9f6d1b4a8c2e5f7a0d3b6c9e2f5', 'hex');
  const blob = Buffer.from(ns.slice(3), 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8');
}
const r = await fetch('https://stream.hls.lol/helios?tmdbId=693134&type=movie', { headers: HEADERS, signal: AbortSignal.timeout(10000) });
const j = await r.json();
for (const [name, src] of Object.entries(j.sources || {})) {
  const u = src?.url || '';
  let out = u;
  if (u.startsWith('ns_')) { try { out = dec(u); } catch (e) { out = 'DECRYPT-FAIL: ' + e.message; } }
  console.log(name + ': ' + out.slice(0, 110));
}
const mu = dec(j.sources.Moscow.url);
const m = await fetch(mu, { headers: HEADERS, signal: AbortSignal.timeout(10000), redirect: 'follow' });
const mb = await m.text();
console.log('Moscow master:', m.status, 'len=' + mb.length, mb.startsWith('#EXTM3U') ? 'IS-M3U8' : mb.slice(0, 80));
console.log('variants:', mb.split('\n').filter(l => l.includes('RESOLUTION')).length);
console.log(mb.split('\n').slice(0, 6).join('\n').slice(0, 400));
