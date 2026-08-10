// Test various dubType values to find the actual English audio dub
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://player.zxcstream.xyz';
const SECRET = '24356351231432574635345245245252324';
const FIELD_MAP = {
  id: 'c81f7a42d9e253b16f408', fToken: '9e3c7bd314af65281d0e49b73', ts: '54d8b21fc9a374e60b1fd',
  token: 'b7f18e4c25d963a50ef81c4a9', title: '2af9c71de384b5630c91e', year: 'f0b34e8d61c6a9275a14f',
  season: 'd41e8c6b259af73510fc48a7e', episode: '8b7d13fa8e620c9541d8e7bc2', imdbId: '6e2af5c97d19840b3f81a6d54',
};

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

function genToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);
  return { xt, rt: ts };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getStreamsWithActive(tmdbId, mediaType, season, episode, serverId, dubCode, dubType) {
  const playerUrl = `${BASE}/player/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}?server=${serverId}&subLang=english`;

  const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/${mediaType}/${tmdbId}?language=en-US`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const details = JSON.parse(detailsRes.body);

  await sleep(800);

  const { xt, rt } = genToken(String(tmdbId));
  const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': playerUrl },
    body: JSON.stringify({ [FIELD_MAP.id]: String(tmdbId), [FIELD_MAP.fToken]: xt, [FIELD_MAP.ts]: String(rt) }),
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const tj = JSON.parse(tokenRes.body);

  await sleep(1500);

  const params = new URLSearchParams();
  params.set(FIELD_MAP.id, String(tmdbId));
  params.set('b', mediaType);
  params.set(FIELD_MAP.ts, String(tj[FIELD_MAP.ts]));
  params.set(FIELD_MAP.token, tj[FIELD_MAP.token]);
  params.set(FIELD_MAP.fToken, xt);
  params.set(FIELD_MAP.title, details.title || details.name || '');
  params.set(FIELD_MAP.year, (details.release_date || details.first_air_date || '').slice(0, 4));
  params.set('date', details.release_date || details.first_air_date || '');
  if (mediaType === 'tv') {
    params.set(FIELD_MAP.season, String(season));
    params.set(FIELD_MAP.episode, String(episode));
  }
  if (details.imdb_id) params.set(FIELD_MAP.imdbId, details.imdb_id);
  if (dubCode !== undefined && dubType !== undefined && dubType !== null) {
    params.set('dubCode', dubCode);
    params.set('dubType', String(dubType));
  }

  const serversRes = await gotScraping.get(`${BASE}/backend_/servers/${serverId}?${params.toString()}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
  });
  if (serversRes.statusCode !== 200) return { status: serversRes.statusCode };
  try { return JSON.parse(serversRes.body); } catch { return null; }
}

console.log('=== Jujutsu Kaisen S01E01 on 1icarus — dubType variations ===\n');

// Default (no dubCode)
console.log('--- Default (no dubCode) ---');
let r = await getStreamsWithActive('95479', 'tv', 1, 1, '1icarus');
console.log('  active:', r.active);
console.log('  links[0]:', r.links?.[0]?.link?.slice(0, 80));
await sleep(2000);

// dubCode=en, dubType=1 (subtitle)
console.log('\n--- dubCode=en, dubType=1 ---');
r = await getStreamsWithActive('95479', 'tv', 1, 1, '1icarus', 'en', 1);
console.log('  active:', r.active);
console.log('  links[0]:', r.links?.[0]?.link?.slice(0, 80));
await sleep(2000);

// dubCode=en, dubType=0 (audio) - JS doesn't send this but let's try
console.log('\n--- dubCode=en, dubType=0 (forced) ---');
r = await getStreamsWithActive('95479', 'tv', 1, 1, '1icarus', 'en', 0);
console.log('  active:', r.active);
console.log('  links[0]:', r.links?.[0]?.link?.slice(0, 80));
await sleep(2000);

// dubCode=en, dubType=2 (unknown)
console.log('\n--- dubCode=en, dubType=2 ---');
r = await getStreamsWithActive('95479', 'tv', 1, 1, '1icarus', 'en', 2);
console.log('  active:', r.active);
console.log('  links[0]:', r.links?.[0]?.link?.slice(0, 80));
await sleep(2000);

// Try without dubType, only dubCode
console.log('\n--- dubCode=en only (no dubType) ---');
const playerUrl = `${BASE}/player/tv/95479/1/1?server=1icarus&subLang=english`;
const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/tv/95479?language=en-US`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
const details = JSON.parse(detailsRes.body);
const { xt, rt } = genToken('95479');
const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': playerUrl },
  body: JSON.stringify({ [FIELD_MAP.id]: '95479', [FIELD_MAP.fToken]: xt, [FIELD_MAP.ts]: String(rt) }),
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
const tj = JSON.parse(tokenRes.body);
const params = new URLSearchParams();
params.set(FIELD_MAP.id, '95479');
params.set('b', 'tv');
params.set(FIELD_MAP.ts, String(tj[FIELD_MAP.ts]));
params.set(FIELD_MAP.token, tj[FIELD_MAP.token]);
params.set(FIELD_MAP.fToken, xt);
params.set(FIELD_MAP.title, details.title || details.name || '');
params.set(FIELD_MAP.year, (details.first_air_date || '').slice(0, 4));
params.set('date', details.first_air_date || '');
params.set(FIELD_MAP.season, '1');
params.set(FIELD_MAP.episode, '1');
params.set('dubCode', 'en');
// NO dubType
const serversRes = await gotScraping.get(`${BASE}/backend_/servers/1icarus?${params.toString()}`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
  timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
});
console.log('  Status:', serversRes.statusCode);
try { const r2 = JSON.parse(serversRes.body); console.log('  active:', r2.active); console.log('  links[0]:', r2.links?.[0]?.link?.slice(0, 80)); } catch { console.log('  body:', serversRes.body.slice(0, 200)); }
