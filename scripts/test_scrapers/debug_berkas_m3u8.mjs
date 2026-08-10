// Check Berkas m3u8 content for relative URLs
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://player.zxcstream.xyz';
const SECRET = '24356351231432574635345245245252324';
const FM = { id: 'c81f7a42d9e253b16f408', fToken: '9e3c7bd314af65281d0e49b73', ts: '54d8b21fc9a374e60b1fd', token: 'b7f18e4c25d963a50ef81c4a9', title: '2af9c71de384b5630c91e', year: 'f0b34e8d61c6a9275a14f', season: 'd41e8c6b259af73510fc48a7e', episode: '8b7d13fa8e620c9541d8e7bc2', imdbId: '6e2af5c97d19840b3f81a6d54' };
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

const tmdbId = '155';
const ts = Date.now();
const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);

const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': `${BASE}/player/movie/155` },
  body: JSON.stringify({ [FM.id]: tmdbId, [FM.fToken]: xt, [FM.ts]: String(ts) }),
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
const tj = JSON.parse(tokenRes.body);

const params = new URLSearchParams();
params.set(FM.id, tmdbId);
params.set('b', 'movie');
params.set(FM.ts, String(tj[FM.ts]));
params.set(FM.token, tj[FM.token]);
params.set(FM.fToken, xt);
params.set(FM.title, 'The Dark Knight');
params.set(FM.year, '2008');
params.set('date', '2008-07-16');
params.set(FM.imdbId, 'tt0468569');

const berkasRes = await gotScraping.get(`${BASE}/backend_/servers/1berkas?${params.toString()}`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': `${BASE}/player/movie/155` },
  timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
});
const d = JSON.parse(berkasRes.body);
const masterUrl = d.links[0].link;

console.log('=== Master m3u8 ===');
console.log(`URL: ${masterUrl}`);
const r = await gotScraping.get(masterUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true, followRedirect: true,
});
console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']}`);
console.log(`\nFull m3u8 content:`);
console.log(r.body);

// Check if variant URLs are relative or absolute
const lines = r.body.split('\n').filter(l => l.trim() && !l.startsWith('#'));
console.log(`\nVariant/segment URLs in m3u8:`);
for (const l of lines) {
  console.log(`  ${l}`);
  try {
    const resolved = new URL(l, masterUrl).href;
    console.log(`    resolved: ${resolved}`);
  } catch { console.log(`    (not a valid URL)`); }
}
