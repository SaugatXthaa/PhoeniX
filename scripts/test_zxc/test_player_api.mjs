// Test /backend/token__ (double underscore) endpoint from /player/ route
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://player.zxcstream.xyz';
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

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

function genToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);
  return { xt, rt: ts };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testPlayer(tmdbId, mediaType, season, episode, serverId = 0) {
  console.log(`\n========================================`);
  console.log(`TEST: ${mediaType} ${tmdbId}${mediaType === 'tv' ? ` S${season}E${episode}` : ''} server=${serverId}`);
  console.log('========================================');

  // Step 0: Visit player page to set cookies/referer
  const playerUrl = `${BASE}/player/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}?server=${serverId}&subLang=english`;
  console.log(`Visit: ${playerUrl}`);
  const visitRes = await gotScraping.get(playerUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Visit: ${visitRes.statusCode}`);

  await sleep(2000);

  // Step 1: Get TMDB details for imdbId, title, year, date
  const detailsUrl = `${BASE}/backend/tmdb/details/${mediaType}/${tmdbId}?language=en-US`;
  console.log(`GET /backend/tmdb/details/${mediaType}/${tmdbId}`);
  const detailsRes = await gotScraping.get(detailsUrl, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      'Accept': 'application/json, text/plain, */*',
      'Referer': playerUrl,
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Details: ${detailsRes.statusCode}`);
  let details;
  try { details = JSON.parse(detailsRes.body); } catch {}
  if (!details) {
    console.log(`Body: ${detailsRes.body.slice(0, 500)}`);
    return null;
  }
  const imdbId = details.imdb_id;
  const title = details.title || details.name;
  const year = (details.release_date || details.first_air_date || '').slice(0, 4);
  const date = details.release_date || details.first_air_date || '';
  console.log(`title="${title}" year="${year}" date="${date}" imdbId="${imdbId}"`);

  await sleep(2000);

  // Step 2: POST /backend/token__ with double underscore
  const { xt, rt } = genToken(String(tmdbId));
  const tokenBody = {
    [FIELD_MAP.id]: String(tmdbId),
    [FIELD_MAP.fToken]: xt,
    [FIELD_MAP.ts]: String(rt),
  };
  console.log(`POST /backend/token__`);
  const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': BASE,
      'Referer': playerUrl,
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify(tokenBody),
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Token: ${tokenRes.statusCode}`);
  console.log(`Body: ${tokenRes.body.slice(0, 500)}`);

  if (tokenRes.statusCode !== 200) return null;
  let tokenJson;
  try { tokenJson = JSON.parse(tokenRes.body); } catch { return null; }

  const realToken = tokenJson[FIELD_MAP.token];
  const realTs = tokenJson[FIELD_MAP.ts];
  if (!realToken || !realTs) {
    console.log('Missing token/ts in response');
    console.log('Full response:', JSON.stringify(tokenJson, null, 2));
    return null;
  }

  await sleep(1500);

  // Step 3: GET /backend_/servers/{serverId}?...
  const params = new URLSearchParams();
  params.set(FIELD_MAP.id, String(tmdbId));
  params.set('b', mediaType);
  params.set(FIELD_MAP.ts, String(realTs));
  params.set(FIELD_MAP.token, realToken);
  params.set(FIELD_MAP.fToken, xt);
  params.set(FIELD_MAP.title, title);
  params.set(FIELD_MAP.year, year);
  params.set('date', date);
  if (mediaType === 'tv') {
    params.set(FIELD_MAP.season, String(season));
    params.set(FIELD_MAP.episode, String(episode));
  }
  if (imdbId) params.set(FIELD_MAP.imdbId, imdbId);

  const serversUrl = `${BASE}/backend_/servers/${serverId}?${params.toString()}`;
  console.log(`GET /backend_/servers/${serverId}?... (len ${serversUrl.length})`);
  const serversRes = await gotScraping.get(serversUrl, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      'Accept': 'application/json, text/plain, */*',
      'Referer': playerUrl,
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Servers: ${serversRes.statusCode}`);
  console.log(`Body: ${serversRes.body.slice(0, 2500)}`);

  return { tokenJson, serversBody: serversRes.body, statusCode: serversRes.statusCode };
}

// Test cases
await testPlayer('155', 'movie', undefined, undefined, 0);
await sleep(5000);
await testPlayer('155', 'movie', undefined, undefined, 1);
await sleep(5000);
await testPlayer('1396', 'tv', 1, 1, 0);
