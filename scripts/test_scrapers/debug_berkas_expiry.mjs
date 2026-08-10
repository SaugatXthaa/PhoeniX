// Check if the Berkas master m3u8 URL expires quickly
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

console.log(`Master URL fetched at: ${new Date().toISOString()}`);
console.log(`URL: ${masterUrl.slice(0, 100)}...`);

// Test immediately
console.log('\n=== Test 1: Immediate ===');
let r = await gotScraping.get(masterUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
console.log(`Status: ${r.statusCode} | Body len: ${r.body?.length || 0}`);
let masterBody = r.body;

// Extract variant URL
const variantLine = masterBody.split('\n').find(l => l.trim() && !l.startsWith('#') && l.includes('http'));
if (variantLine) {
  const variantUrl = variantLine.trim();
  console.log(`\nVariant URL: ${variantUrl.slice(0, 100)}...`);

  // Test variant immediately
  console.log('\n=== Test 2: Variant immediate ===');
  r = await gotScraping.get(variantUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Status: ${r.statusCode} | Body len: ${r.body?.length || 0}`);
  if (r.statusCode === 200) {
    console.log(`First 300: ${r.body.slice(0, 300)}`);
  } else {
    console.log(`Body: ${r.body?.slice(0, 200)}`);
  }

  // Wait 5 seconds and test again
  console.log('\n=== Test 3: Variant after 5s ===');
  await new Promise(r => setTimeout(r, 5000));
  r = await gotScraping.get(variantUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Status: ${r.statusCode} | Body: ${r.body?.slice(0, 100)}`);

  // Wait 30 more seconds
  console.log('\n=== Test 4: Variant after 35s total ===');
  await new Promise(r => setTimeout(r, 30000));
  r = await gotScraping.get(variantUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Status: ${r.statusCode} | Body: ${r.body?.slice(0, 100)}`);

  // Also test master URL after 35s
  console.log('\n=== Test 5: Master after 35s ===');
  r = await gotScraping.get(masterUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Status: ${r.statusCode} | Body len: ${r.body?.length || 0}`);
}
