// Try with persistent cookie jar — capture CF cookies from embed page first
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

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

const cookieJar = new CookieJar();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function genToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);
  return { xt, rt: ts };
}

// Step 0: Visit embed page to get CF cookies
console.log('=== Step 0: Visit embed page ===');
const embedRes = await gotScraping.get(`${BASE}/embed/movie/155`, {
  cookieJar,
  headers: {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
console.log(`Embed: ${embedRes.statusCode}`);
console.log(`Set-Cookie: ${JSON.stringify(embedRes.headers['set-cookie'] || 'none')}`);

// Print all cookies in jar
const cookies = await cookieJar.getCookies(BASE);
console.log(`Cookies in jar: ${cookies.length}`);
for (const c of cookies) console.log(`  ${c.key}=${c.value.slice(0, 40)}...`);

// Wait for browser to "settle"
await new Promise(r => setTimeout(r, 5000));

// Step 1: Get TMDB details (which provides imdb_id)
console.log('\n=== Step 1: /backend/tmdb/details/movie/155 ===');
const { xt, rt } = genToken('155');
const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/movie/155?language=en-US`, {
  cookieJar,
  headers: {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${BASE}/embed/movie/155`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
console.log(`Details: ${detailsRes.statusCode}`);
let imdbId;
try { imdbId = JSON.parse(detailsRes.body).imdb_id; } catch {}
console.log(`imdb_id: ${imdbId}`);

// Wait
await new Promise(r => setTimeout(r, 3000));

// Step 2: /backend/token
console.log('\n=== Step 2: /backend/token (with cookies) ===');
const tokenParams = new URLSearchParams();
tokenParams.set(FIELD_MAP.id, '155');
tokenParams.set(FIELD_MAP.fToken, xt);
tokenParams.set(FIELD_MAP.ts, String(rt));
if (imdbId) tokenParams.set(FIELD_MAP.imdbId, imdbId);

const tokenRes = await gotScraping.get(`${BASE}/backend/token?${tokenParams.toString()}`, {
  cookieJar,
  headers: {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${BASE}/embed/movie/155`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
console.log(`Token: ${tokenRes.statusCode}`);
console.log(`Body: ${tokenRes.body.slice(0, 600)}`);

if (tokenRes.statusCode === 200) {
  let j;
  try { j = JSON.parse(tokenRes.body); } catch {}
  if (j) {
    const realToken = j[FIELD_MAP.token];
    const realTs = j[FIELD_MAP.ts];
    console.log(`Got token! ts=${realTs}`);
    await new Promise(r => setTimeout(r, 2000));
    console.log('\n=== Step 3: /backend_/embed/sentinel ===');
    const sp = new URLSearchParams();
    sp.set(FIELD_MAP.id, '155');
    sp.set('b', 'movie');
    sp.set(FIELD_MAP.ts, String(realTs));
    sp.set(FIELD_MAP.token, realToken);
    sp.set(FIELD_MAP.fToken, xt);
    if (imdbId) sp.set(FIELD_MAP.imdbId, imdbId);
    const sRes = await gotScraping.get(`${BASE}/backend_/embed/sentinel?${sp.toString()}`, {
      cookieJar,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${BASE}/embed/movie/155`,
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
      },
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
    });
    console.log(`Sentinel: ${sRes.statusCode}`);
    console.log(`Body: ${sRes.body.slice(0, 1500)}`);
  }
}
