// Task 86: replicate Atlantic gate bootstrap from sandbox egress
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

const GATES = {
  a: { cLabel: 'a', version: 'aphrodite.a.v1', seedHex: 'e85b060a65626b661c66fb09b143f7218dbe9285441890158a1703b3677172b9', bootstrapUrl: 'https://cdn.hls.lol/content/index' },
  b: { cLabel: 'b', version: 'stellar.b.v1', seedHex: '9a9080abdc4d5d7331b3514cfe4000731d53c9ed6e797970e17964cd6bef2ab6', bootstrapUrl: 'https://stellar.hls.lol/gate/handshake' },
};

for (const g of Object.values(GATES)) {
  g.masterKey = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(g.version, 'utf8'), Buffer.from(g.seedHex, 'hex')]))
    .digest();
}

async function bootstrap(g) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', g.masterKey).update(`${g.cLabel}|${ts}|${nonce}`).digest('hex');
  const t0 = Date.now();
  try {
    const res = await fetch(g.bootstrapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ c: g.cLabel, ts, n: nonce, s: sig }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    console.log(`gate[${g.cLabel}] ${g.bootstrapUrl} → ${res.status} ${Date.now() - t0}ms len=${body.length}`);
    if (res.ok) {
      const j = JSON.parse(body);
      console.log('  keys:', Object.keys(j), '| d len:', j.d?.length);
      // decrypt
      const blob = Buffer.from(j.d, 'hex');
      const iv = blob.subarray(0, 12), tag = blob.subarray(blob.length - 16);
      const d = crypto.createDecipheriv('aes-256-gcm', g.masterKey, iv);
      d.setAuthTag(tag);
      const plain = Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
      const obj = JSON.parse(plain.toString('utf8'));
      console.log('  session: sid=' + obj.sid + ' skey=' + (obj.skey || '').slice(0, 8) + '… exp=' + new Date((obj.exp || 0) * 1000).toISOString() + ' (in ' + Math.round(((obj.exp || 0) - Date.now() / 1000) / 60) + 'min)');
      return obj;
    } else {
      console.log('  body head:', body.slice(0, 120).replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log(`gate[${g.cLabel}] FAIL ${Date.now() - t0}ms: ${e.message}`);
  }
  return null;
}

const sessA = await bootstrap(GATES.a);
const sessB = await bootstrap(GATES.b);

// If gate b worked, try a full artemis resolve for Dune 2
if (sessB) {
  const g = GATES.b;
  const path = '/resolve?tmdbId=693134&type=movie';
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', Buffer.from(sessB.skey, 'hex')).update(`${sessB.sid}|${path}|${ts}|${nonce}`).digest('hex');
  const r = await fetch('https://stellar.hls.lol' + path, {
    headers: { 'X-S-Sid': sessB.sid, 'X-S-Ts': String(ts), 'X-S-Nonce': nonce, 'X-S-Sig': sig, ...HEADERS },
    signal: AbortSignal.timeout(10000),
  });
  const body = await r.text();
  console.log('artemis resolve →', r.status, 'len=' + body.length);
  console.log('  body head:', body.slice(0, 300).replace(/\s+/g, ' '));
}
