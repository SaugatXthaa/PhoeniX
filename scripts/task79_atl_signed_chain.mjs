// Task 79: full SIGNED atlantic chain test — both gates, real payloads
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Origin': 'https://atlantic.st', 'Referer': 'https://atlantic.st/' };

const GATES = {
  a: { // aphrodite — cdn.hls.lol
    label: 'a', version: 'aphrodite.a.v1',
    seed: Buffer.from('e85b060a65626b661c66fb09b143f7218dbe9285441890158a1703b3677172b9', 'hex'),
    bootstrapUrl: 'https://cdn.hls.lol/content/index',
    hdrPrefix: 'X-A',
  },
  b: { // stellar — stellar.hls.lol
    label: 'b', version: 'stellar.b.v1',
    seed: Buffer.from('9a9080abdc4d5d7331b3514cfe4000731d53c9ed6e797970e17964cd6bef2ab6', 'hex'),
    bootstrapUrl: 'https://stellar.hls.lol/gate/handshake',
    hdrPrefix: 'X-S',
  },
};
for (const g of Object.values(GATES)) {
  g.masterKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(g.version, 'utf8'), g.seed])).digest();
}

function sign(g, msg) {
  return crypto.createHmac('sha256', g.masterKey).update(msg).digest('hex');
}

async function bootstrap(g) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = sign(g, `${g.label}|${ts}|${nonce}`);
  const res = await fetch(g.bootstrapUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({ c: g.label, ts, n: nonce, s: sig }),
    signal: AbortSignal.timeout(8000),
  });
  console.log(`bootstrap ${g.label} (${g.bootstrapUrl}): HTTP ${res.status}`);
  if (!res.ok) { console.log('  body:', (await res.text()).slice(0, 150)); return null; }
  const j = await res.json();
  const blob = Buffer.from(j.d, 'hex');
  const iv = blob.subarray(0, 12), tag = blob.subarray(blob.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', g.masterKey, iv);
  d.setAuthTag(tag);
  const obj = JSON.parse(Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8'));
  console.log(`  session sid=${obj.sid?.slice(0, 12)}… skey=${String(obj.skey).slice(0, 12)}… exp=${obj.exp}`);
  return { sid: String(obj.sid), skey: Buffer.from(String(obj.skey), 'hex') };
}

function signedHeaders(g, sess, path) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', sess.skey).update(`${sess.sid}|${path}|${ts}|${nonce}`).digest('hex');
  return { [`${g.hdrPrefix}-Sid`]: sess.sid, [`${g.hdrPrefix}-Ts`]: String(ts), [`${g.hdrPrefix}-Nonce`]: nonce, [`${g.hdrPrefix}-Sig`]: sig };
}

(async () => {
  const sessA = await bootstrap(GATES.a);
  const sessB = await bootstrap(GATES.b);
  if (!sessA || !sessB) return console.log('bootstrap failed — cannot continue');

  // 1. signed aphrodite content GET
  const pathA = '/content/movie/693134';
  const rA = await fetch('https://cdn.hls.lol' + pathA, { headers: { ...signedHeaders(GATES.a, sessA, pathA), ...HEADERS }, signal: AbortSignal.timeout(8000) });
  const jA = await rA.json().catch(() => null);
  console.log(`\ncontent/movie/693134 (SIGNED): HTTP ${rA.status} →`, JSON.stringify(jA)?.slice(0, 260));

  // 2. signed stellar resolve
  const pathB = '/resolve?tmdbId=693134&type=movie';
  const rB = await fetch('https://stellar.hls.lol' + pathB, { headers: { ...signedHeaders(GATES.b, sessB, pathB), ...HEADERS }, signal: AbortSignal.timeout(8000) });
  const jB = await rB.json().catch(() => null);
  console.log(`\nresolve (SIGNED): HTTP ${rB.status} →`, JSON.stringify(jB)?.slice(0, 300));

  // 3. fetch whatever payload masters came back (with site headers)
  for (const [name, u] of [['aphrodite', jA?.hls || jA?.url], ['stellar', jB?.url]]) {
    if (!u || !/^https?:\/\//.test(u)) { console.log(`\n[${name}] no payload url`); continue; }
    console.log(`\n[${name}] payload master: ${u.slice(0, 90)}`);
    const m = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const body = await m.text();
    console.log(`  HTTP ${m.status} type=${m.headers.get('content-type')} len=${body.length}`);
    console.log(`  head: ${body.slice(0, 220).replace(/\n/g, ' | ')}`);
    if (body.startsWith('#EXTM3U')) {
      // fetch first child
      const base = new URL(u);
      const childLine = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
      if (childLine) {
        const cu = new URL(childLine.trim(), base).href;
        const c = await fetch(cu, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        const cb = await c.text();
        console.log(`  child: HTTP ${c.status} len=${cb.length} head=${cb.slice(0, 120).replace(/\n/g, ' | ')}`);
      }
    }
  }
})();
