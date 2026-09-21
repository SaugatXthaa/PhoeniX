// Task 71: Atlantic deep diagnosis — artemis master shape + gate bootstrap POST
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Origin': 'https://atlantic.st',
  'Referer': 'https://atlantic.st/',
  'Accept': '*/*',
};

async function main() {
  // 1. Resolve artemis fresh
  const q = new URLSearchParams({ tmdbId: '693134', type: 'movie' });
  const r1 = await fetch(`https://stellar.hls.lol/resolve?${q}`, { headers: HEADERS });
  const j1 = await r1.json();
  console.log('artemis resolve:', JSON.stringify(j1).slice(0, 200));
  if (j1?.url) {
    const r2 = await fetch(j1.url, { headers: HEADERS });
    const body = await r2.text();
    console.log(`\nartemis master HTTP ${r2.status}, ${body.length} bytes, starts: ${body.slice(0, 60).replace(/\n/g, '\\n')}`);
    const hasStreamInf = body.includes('#EXT-X-STREAM-INF');
    const hasExtInf = body.includes('#EXTINF');
    console.log(`STREAM-INF: ${hasStreamInf} | EXTINF: ${hasExtInf}`);
    console.log('--- first 20 lines ---');
    console.log(body.split('\n').slice(0, 20).join('\n').slice(0, 1200));
    // child validation like validatePlaylistChild
    const firstChild = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (firstChild && !hasStreamInf) {
      const childUrl = new URL(firstChild, j1.url).href;
      const r3 = await fetch(childUrl, { headers: HEADERS });
      const cbody = await r3.text();
      console.log(`\nflat child ${childUrl.slice(0, 90)} → HTTP ${r3.status}, starts: ${cbody.slice(0, 60).replace(/\n/g, '\\n')}`);
    }
  }

  // 2. Aphrodite gate bootstrap POST (same math as atlantic.cjs)
  const GATE_M = new Uint8Array([152, 159, 215, 12, 139, 229, 103, 92, 79, 156, 87, 240, 161, 70, 97, 40, 218, 79, 171, 72, 9, 177, 171, 147, 62, 249, 164, 146, 201, 90, 184, 204, 237, 159, 162, 35, 55, 32, 234, 114, 164, 188, 27, 63, 151, 213, 4, 92, 117, 56, 136, 58, 252, 220, 222, 69, 186, 144, 227, 223, 214, 102, 114, 251]);
  const GATE_X = new Uint8Array([223, 178, 166, 138, 172, 171, 123, 225, 225, 38, 113, 78, 41, 179, 108, 148, 174, 227, 135, 224, 100, 253, 252, 79, 116, 151, 43, 67, 103, 203, 90, 249]);
  const gateSeed = (() => { const out = Buffer.alloc(32); for (let i = 0; i < 32; i++) out[i] = GATE_M[1 + i * 2] ^ GATE_X[i]; return out; })();
  const gateMasterKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('aphrodite.a.v1', 'utf8'), gateSeed])).digest();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', gateMasterKey).update(`a|${ts}|${nonce}`).digest('hex');
  const rb = await fetch('https://cdn.hls.lol/content/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({ c: 'a', ts, n: nonce, s: sig }),
  });
  console.log(`\ngate bootstrap POST → HTTP ${rb.status}`);
  const jb = await rb.json().catch(() => null);
  console.log('bootstrap response:', jb ? JSON.stringify(jb).slice(0, 150) : '(non-json)');

  // 3. Unsigned GET again for reference (worked before)
  const r4 = await fetch('https://cdn.hls.lol/content/movie/693134', { headers: HEADERS });
  const j4 = await r4.json().catch(() => null);
  console.log(`\nunsigned aphrodite GET → HTTP ${r4.status} found=${j4?.found} hls=${j4?.hls || j4?.url?.slice(0, 60)}`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
