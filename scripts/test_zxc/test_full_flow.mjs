// Single careful attempt at /backend/token with proper spacing
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://player.zxcprime.xyz';
const SECRET = '24356351231432574635345245245252324';

const FIELD_MAP = {
  id: 'c81f7a42d9e253b16f408',
  fToken: '9e3c7bd314af65281d0e49b73',
  ts: '54d8b21fc9a374e60b1fd',
  token: 'b7f18e4c25d963a50ef81c4a9',
  season: 'd41e8c6b259af73510fc48a7e',
  episode: '8b7d13fa8e620c9541d8e7bc2',
  imdbId: '6e2af5c97d19840b3f81a6d54',
};

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

function genToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);
  return { xt, rt: ts };
}

// First, "warm up" by visiting the embed page like a real browser would
console.log('=== Step 0: Visit embed page (warmup) ===');
const embedPage = await gotScraping.get(`${BASE}/embed/movie/155`, {
  headers: {
    ...hg.getHeaders({ httpVersion: '2' }),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
console.log(`Embed page: ${embedPage.statusCode} (len ${embedPage.body.length})`);

// Wait 3 seconds (simulating browser JS init delay)
await new Promise(r => setTimeout(r, 3000));

// Then call /backend/tmdb/details (the page does this first via React Query)
console.log('\n=== Step 1: GET /backend/tmdb/details/movie/155 ===');
const { xt, rt } = genToken('155');
const details = await gotScraping.get(`${BASE}/backend/tmdb/details/movie/155?language=en-US`, {
  headers: {
    ...hg.getHeaders({ httpVersion: '2' }),
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${BASE}/embed/movie/155`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
console.log(`Details: ${details.statusCode}`);
let imdbId;
try { imdbId = JSON.parse(details.body).imdb_id; } catch {}
console.log(`imdb_id: ${imdbId}`);

// Wait 2 seconds
await new Promise(r => setTimeout(r, 2000));

// Now call /backend/token with all params
console.log('\n=== Step 2: GET /backend/token ===');
const tokenParams = new URLSearchParams();
tokenParams.set(FIELD_MAP.id, '155');
tokenParams.set(FIELD_MAP.fToken, xt);
tokenParams.set(FIELD_MAP.ts, String(rt));
if (imdbId) tokenParams.set(FIELD_MAP.imdbId, imdbId);

const tokenRes = await gotScraping.get(`${BASE}/backend/token?${tokenParams.toString()}`, {
  headers: {
    ...hg.getHeaders({ httpVersion: '2' }),
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${BASE}/embed/movie/155`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
console.log(`Token: ${tokenRes.statusCode}`);
console.log(`Body: ${tokenRes.body.slice(0, 500)}`);

if (tokenRes.statusCode === 200) {
  let tokenJson;
  try { tokenJson = JSON.parse(tokenRes.body); } catch {}
  if (tokenJson) {
    const realToken = tokenJson[FIELD_MAP.token];
    const realTs = tokenJson[FIELD_MAP.ts];
    console.log(`Got real token: ${realToken?.slice(0, 16)}... ts: ${realTs}`);

    if (realToken && realTs) {
      // Wait 2 seconds
      await new Promise(r => setTimeout(r, 2000));

      // Now call sentinel
      console.log('\n=== Step 3: GET /backend_/embed/sentinel ===');
      const sParams = new URLSearchParams();
      sParams.set(FIELD_MAP.id, '155');
      sParams.set('b', 'movie');
      sParams.set(FIELD_MAP.ts, String(realTs));
      sParams.set(FIELD_MAP.token, realToken);
      sParams.set(FIELD_MAP.fToken, xt);
      if (imdbId) sParams.set(FIELD_MAP.imdbId, imdbId);

      const sentinelRes = await gotScraping.get(`${BASE}/backend_/embed/sentinel?${sParams.toString()}`, {
        headers: {
          ...hg.getHeaders({ httpVersion: '2' }),
          'Accept': 'application/json, text/plain, */*',
          'Referer': `${BASE}/embed/movie/155`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
      });
      console.log(`Sentinel: ${sentinelRes.statusCode}`);
      console.log(`Body: ${sentinelRes.body.slice(0, 1500)}`);
    }
  }
}
