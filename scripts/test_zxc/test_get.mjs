// Try GET /backend/token with params (server says only GET, HEAD, OPTIONS allowed)
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
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
  console.log(`Generated fToken: ${xt.slice(0, 24)}... (ts=${rt})`);

  // Build the GET URL with all params
  const params = new URLSearchParams();
  params.set(FIELD_MAP.id, String(tmdbId));
  params.set(FIELD_MAP.fToken, xt);
  params.set(FIELD_MAP.ts, String(rt));
  if (mediaType === 'tv') {
    params.set(FIELD_MAP.season, String(season));
    params.set(FIELD_MAP.episode, String(episode));
  }
  if (imdbId) params.set(FIELD_MAP.imdbId, imdbId);

  const tokenUrl = `${BASE}/backend/token?${params.toString()}`;
  console.log(`GET ${tokenUrl.slice(0, 150)}...`);

  const tokenRes = await gotScraping.get(tokenUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': BASE,
      'Referer': `${BASE}/embed/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  console.log(`Status: ${tokenRes.statusCode}`);
  console.log(`Headers: ${JSON.stringify(tokenRes.headers, null, 2)}`);
  console.log(`Body: ${tokenRes.body.slice(0, 1000)}`);

  if (tokenRes.statusCode !== 200) {
    console.log('Failed — aborting');
    return null;
  }

  let tokenJson;
  try { tokenJson = JSON.parse(tokenRes.body); } catch { return null; }

  const token = tokenJson[FIELD_MAP.token];
  const ts = tokenJson[FIELD_MAP.ts];
  if (!token || !ts) return null;
  console.log(`Got token: ${token.slice(0, 24)}... ts: ${ts}`);

  // Now GET sentinel
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
  console.log(`\nGET sentinel...`);
  const sentinelRes = await gotScraping.get(sentinelUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/embed/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}`,
    },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  console.log(`Status: ${sentinelRes.statusCode}`);
  console.log(`Body: ${sentinelRes.body.slice(0, 1500)}`);

  if (sentinelRes.statusCode !== 200) return null;
  try { return JSON.parse(sentinelRes.body); } catch { return null; }
}

// Test movie 155 (The Dark Knight)
console.log('=== TEST: The Dark Knight (movie, tmdb=155) ===');
const r = await getEmbed('155', 'movie');
console.log('\nFINAL:', JSON.stringify(r, null, 2));

await sleep(3000);

console.log('\n\n=== TEST: Breaking Bad S01E01 (tv, tmdb=1396) ===');
const r2 = await getEmbed('1396', 'tv', 1, 1);
console.log('\nFINAL:', JSON.stringify(r2, null, 2));
