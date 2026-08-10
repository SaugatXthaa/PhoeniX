// Test all 8 ZXC servers with proper server IDs
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

const SERVERS = [
  { id: '1orion',    label: 'Orion I',      desc: 'Built-In Subtitle - English' },
  { id: '1icarus',   label: 'Icarus II',    desc: 'Download & Multi Audio Support' },
  { id: '1berkas',   label: 'Berkas III',   desc: '4K Support & Fast' },
  { id: '1resshin',  label: 'Resshin IV',   desc: 'Download & Multi Audio Support' },
  { id: '1daedalus', label: 'Daedalus',     desc: 'Alternative' },
  { id: '1athena',   label: 'Athena V',     desc: 'Main Server & Multi Audio Support' },
  { id: '1sentinel', label: 'Sentinel VI',  desc: 'K-Dramas, C-Dramas & Asian movies' },
  { id: 'resshin',   label: 'Resshin',      desc: 'Download & Multi Audio Support' },
];

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

function genToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);
  return { xt, rt: ts };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testServer(tmdbId, mediaType, season, episode, server) {
  console.log(`\n--- ${mediaType} ${tmdbId}${mediaType === 'tv' ? ` S${season}E${episode}` : ''} server=${server.id} (${server.label}) ---`);

  const playerUrl = `${BASE}/player/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}?server=${server.id}&subLang=english`;

  // Step 1: Get TMDB details
  const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/${mediaType}/${tmdbId}?language=en-US`, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      'Accept': 'application/json, text/plain, */*',
      'Referer': playerUrl,
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  let details;
  try { details = JSON.parse(detailsRes.body); } catch {}
  if (!details) {
    console.log(`  Details failed: ${detailsRes.statusCode}`);
    return null;
  }
  const imdbId = details.imdb_id;
  const title = details.title || details.name;
  const year = (details.release_date || details.first_air_date || '').slice(0, 4);
  const date = details.release_date || details.first_air_date || '';

  await sleep(800);

  // Step 2: POST /backend/token__
  const { xt, rt } = genToken(String(tmdbId));
  const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': BASE,
      'Referer': playerUrl,
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({
      [FIELD_MAP.id]: String(tmdbId),
      [FIELD_MAP.fToken]: xt,
      [FIELD_MAP.ts]: String(rt),
    }),
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (tokenRes.statusCode !== 200) {
    console.log(`  Token failed: ${tokenRes.statusCode}`);
    return null;
  }
  let tokenJson;
  try { tokenJson = JSON.parse(tokenRes.body); } catch { return null; }
  const realToken = tokenJson[FIELD_MAP.token];
  const realTs = tokenJson[FIELD_MAP.ts];
  if (!realToken || !realTs) return null;

  await sleep(1500);  // The JS code has a 1200ms delay before getting servers

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

  const serversUrl = `${BASE}/backend_/servers/${server.id}?${params.toString()}`;
  const serversRes = await gotScraping.get(serversUrl, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      'Accept': 'application/json, text/plain, */*',
      'Referer': playerUrl,
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
  });
  const ct = serversRes.headers['content-type'] || '';
  console.log(`  Servers: ${serversRes.statusCode} (CT: ${ct})`);
  if (serversRes.statusCode === 200 && (ct.includes('json') || ct.includes('text/plain'))) {
    console.log(`  Body: ${serversRes.body.slice(0, 1200)}`);
  } else if (serversRes.statusCode === 200) {
    console.log(`  Body (HTML?): ${serversRes.body.slice(0, 300)}`);
  } else {
    console.log(`  Body: ${serversRes.body.slice(0, 300)}`);
  }
  return serversRes;
}

console.log('========== TEST 1: The Dark Knight (movie 155) ==========');
for (const s of SERVERS) {
  try { await testServer('155', 'movie', undefined, undefined, s); } catch (e) { console.log(`ERR: ${e.message}`); }
  await sleep(2000);
}

console.log('\n\n========== TEST 2: Breaking Bad S01E01 (tv 1396) ==========');
for (const s of SERVERS) {
  try { await testServer('1396', 'tv', 1, 1, s); } catch (e) { console.log(`ERR: ${e.message}`); }
  await sleep(2000);
}
