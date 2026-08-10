// Use proper got-scraping with headerGenerator to bypass Cloudflare
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
  title: '2af9c71de384b5630c91e',
  year: 'f0b34e8d61c6a9275a14f',
  season: 'd41e8c6b259af73510fc48a7e',
  episode: '8b7d13fa8e620c9541d8e7bc2',
  imdbId: '6e2af5c97d19840b3f81a6d54',
};

const hg = new HeaderGenerator({
  browsers: ['chrome'],
  devices: ['desktop'],
  operatingSystems: ['windows'],
  locales: ['en-US', 'en'],
});

function genToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512')
    .update(`${ts}:${SECRET}:${tmdbId}`)
    .digest('hex')
    .slice(0, 64);
  return { xt, rt: ts };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getEmbed(tmdbId, mediaType, season, episode, imdbId) {
  const { xt, rt } = genToken(tmdbId);
  console.log(`fToken: ${xt.slice(0, 16)}... ts: ${rt}`);

  // Step 1: GET /backend/token with all params
  const tokenParams = new URLSearchParams();
  tokenParams.set(FIELD_MAP.id, String(tmdbId));
  tokenParams.set(FIELD_MAP.fToken, xt);
  tokenParams.set(FIELD_MAP.ts, String(rt));
  if (mediaType === 'tv') {
    tokenParams.set(FIELD_MAP.season, String(season));
    tokenParams.set(FIELD_MAP.episode, String(episode));
  }
  if (imdbId) tokenParams.set(FIELD_MAP.imdbId, imdbId);

  const tokenUrl = `${BASE}/backend/token?${tokenParams.toString()}`;
  const browserHeaders = hg.getHeaders({ httpVersion: '2' });

  console.log(`GET /backend/token (using browser headers)`);
  const tokenRes = await gotScraping.get(tokenUrl, {
    headers: {
      ...browserHeaders,
      'Accept': 'application/json, text/plain, */*',
      'Origin': BASE,
      'Referer': `${BASE}/embed/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    timeout: { request: 20000 },
    throwHttpErrors: false,
    http2: true,
  });
  console.log(`Status: ${tokenRes.statusCode} | Body: ${tokenRes.body.slice(0, 500)}`);

  if (tokenRes.statusCode !== 200) return null;

  let tokenJson;
  try { tokenJson = JSON.parse(tokenRes.body); } catch { return null; }

  const token = tokenJson[FIELD_MAP.token];
  const ts = tokenJson[FIELD_MAP.ts];
  if (!token || !ts) {
    console.log('Full response:', JSON.stringify(tokenJson, null, 2));
    return null;
  }
  console.log(`Got token OK`);

  await sleep(800);  // small delay between requests

  // Step 2: GET /backend_/embed/sentinel
  const sentinelParams = new URLSearchParams();
  sentinelParams.set(FIELD_MAP.id, String(tmdbId));
  sentinelParams.set('b', mediaType);
  sentinelParams.set(FIELD_MAP.ts, String(ts));
  sentinelParams.set(FIELD_MAP.token, token);
  sentinelParams.set(FIELD_MAP.fToken, xt);
  if (mediaType === 'tv') {
    sentinelParams.set(FIELD_MAP.season, String(season));
    sentinelParams.set(FIELD_MAP.episode, String(episode));
  }
  if (imdbId) sentinelParams.set(FIELD_MAP.imdbId, imdbId);

  const sentinelUrl = `${BASE}/backend_/embed/sentinel?${sentinelParams.toString()}`;
  console.log(`GET /backend_/embed/sentinel`);
  const sentinelRes = await gotScraping.get(sentinelUrl, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/embed/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    timeout: { request: 20000 },
    throwHttpErrors: false,
    http2: true,
  });
  console.log(`Status: ${sentinelRes.statusCode} | Body: ${sentinelRes.body.slice(0, 1500)}`);

  if (sentinelRes.statusCode !== 200) return null;
  try { return JSON.parse(sentinelRes.body); } catch { return null; }
}

console.log('=== TEST: The Dark Knight (movie, tmdb=155) ===');
const r = await getEmbed('155', 'movie');
console.log('\nFINAL:', JSON.stringify(r, null, 2));

await sleep(5000);

console.log('\n\n=== TEST: Breaking Bad S01E01 (tv, tmdb=1396) ===');
const r2 = await getEmbed('1396', 'tv', 1, 1);
console.log('\nFINAL:', JSON.stringify(r2, null, 2));
