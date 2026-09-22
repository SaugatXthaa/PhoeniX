// Task 79: multi-round atlantic chain stability probe
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BH = { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Origin': 'https://atlantic.st', 'Referer': 'https://atlantic.st/', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site' };

function gate(g) {
  const conf = g === 'a'
    ? { ver: 'aphrodite.a.v1', seed: 'e85b060a65626b661c66fb09b143f7218dbe9285441890158a1703b3677172b9', url: 'https://cdn.hls.lol/content/index', p: 'X-A' }
    : { ver: 'stellar.b.v1', seed: '9a9080abdc4d5d7331b3514cfe4000731d53c9ed6e797970e17964cd6bef2ab6', url: 'https://stellar.hls.lol/gate/handshake', p: 'X-S' };
  const masterKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(conf.ver), Buffer.from(conf.seed, 'hex')])).digest();
  return { ...conf, masterKey };
}

async function boot(g) {
  const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', g.masterKey).update(`${g.label ?? ''}${''}` + `${g === undefined ? '' : ''}`).digest('hex'); // placeholder
  return { ts, nonce };
}

// simpler: single generic signed request helper
async function signedCall(g, path) {
  const ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', g.masterKey).update(`${g.cLabel}|${ts}|${nonce}`).digest('hex');
  const res = await fetch(g.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...BH },
    body: JSON.stringify({ c: g.cLabel, ts, n: nonce, s: sig }), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { err: `bootstrap ${res.status}` };
  const j = await res.json();
  const blob = Buffer.from(j.d, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', g.masterKey, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(blob.length - 16));
  const sess = JSON.parse(Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString());
  const skey = Buffer.from(sess.skey, 'hex');
  const ts2 = Math.floor(Date.now() / 1000), n2 = crypto.randomBytes(8).toString('hex');
  const sig2 = crypto.createHmac('sha256', skey).update(`${sess.sid}|${path}|${ts2}|${n2}`).digest('hex');
  const host = g.cLabel === 'a' ? 'https://cdn.hls.lol' : 'https://stellar.hls.lol';
  const r = await fetch(host + path, {
    headers: { [`${g.p}-Sid`]: sess.sid, [`${g.p}-Ts`]: String(ts2), [`${g.p}-Nonce`]: n2, [`${g.p}-Sig`]: sig2, ...BH },
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

const GA = { ...gate('a'), cLabel: 'a' };
const GB = { ...gate('b'), cLabel: 'b' };

async function validateMaster(tag, mu) {
  const m = await fetch(mu, { headers: BH, signal: AbortSignal.timeout(10000) });
  const body = await m.text();
  if (!body.startsWith('#EXTM3U')) return `${tag} master HTTP ${m.status} NOT-M3U8 (${body.length}B)`;
  const children = body.split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  const results = [];
  for (const cu of children.slice(0, 2)) {
    const c = await fetch(cu, { headers: BH, signal: AbortSignal.timeout(10000) });
    const cb = await c.text();
    if (!cb.startsWith('#EXTM3U')) { results.push(`child ${c.status}`); continue; }
    const segs = cb.split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'));
    if (!segs.length) { results.push('child OK 0segs'); continue; }
    const s = await fetch(new URL(segs[0], cu).href, { headers: { ...BH, Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(10000) });
    const buf = new Uint8Array(await s.arrayBuffer());
    const magic = buf.subarray(4, 8).toString('latin1');
    results.push(`seg ${s.status} ${buf[0] === 0x47 ? 'TS' : (magic === 'ftyp' || magic === 'styp' || magic === 'moov' ? 'fMP4' : 'bad')}`);
  }
  return `${tag} master OK (${children.length}ch) → ${results.join(', ')}`;
}

(async () => {
  for (let round = 1; round <= 3; round++) {
    console.log(`\n── round ${round} @${new Date().toISOString().slice(11, 19)} ──`);
    try {
      const aph = await signedCall(GA, '/content/movie/693134');
      if (aph.err) console.log('aphrodite:', aph.err);
      else {
        const pu = aph.hls || aph.url;
        console.log('aphrodite: title="' + aph.title + '" payload-host=' + new URL(pu).host);
        console.log(' ', await validateMaster('APHD', pu));
      }
    } catch (e) { console.log('aphrodite ERR:', e.message); }
    try {
      const orb = await signedCall(GB, '/resolve?tmdbId=693134&type=movie');
      if (orb.err) console.log('stellar:', orb.err);
      else {
        console.log('stellar: source=' + orb.source + ' host=' + new URL(orb.url).host);
        console.log(' ', await validateMaster('ORBT', orb.url));
      }
    } catch (e) { console.log('stellar ERR:', e.message); }
    if (round < 3) await new Promise(r => setTimeout(r, 5000));
  }
})();
