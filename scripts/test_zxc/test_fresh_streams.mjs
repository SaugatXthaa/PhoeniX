// Get a fresh stream URL and test it immediately
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

async function getStreams(tmdbId, mediaType, season, episode, serverId) {
  const playerUrl = `${BASE}/player/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}?server=${serverId}&subLang=english`;

  const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/${mediaType}/${tmdbId}?language=en-US`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const details = JSON.parse(detailsRes.body);
  const imdbId = details.imdb_id;
  const title = details.title || details.name;
  const year = (details.release_date || details.first_air_date || '').slice(0, 4);
  const date = details.release_date || details.first_air_date || '';

  await sleep(800);

  const { xt, rt } = genToken(String(tmdbId));
  const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': playerUrl },
    body: JSON.stringify({ [FIELD_MAP.id]: String(tmdbId), [FIELD_MAP.fToken]: xt, [FIELD_MAP.ts]: String(rt) }),
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const tj = JSON.parse(tokenRes.body);
  const realToken = tj[FIELD_MAP.token], realTs = tj[FIELD_MAP.ts];

  await sleep(1500);

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

  const serversRes = await gotScraping.get(`${BASE}/backend_/servers/${serverId}?${params.toString()}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
  });
  return { serversBody: serversRes.body, statusCode: serversRes.statusCode, playerUrl };
}

async function testStream(url, playerUrl) {
  console.log(`  Testing: ${url.slice(0, 100)}...`);
  // Test without Referer
  try {
    const r1 = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`    HEAD no-referer: ${r1.statusCode} CT=${r1.headers['content-type']}`);
  } catch (e) { console.log(`    HEAD no-referer ERR: ${e.message}`); }

  // Test with Origin (since these are CF Workers, they often check Origin)
  try {
    const r2 = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Origin': BASE },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`    HEAD with Origin: ${r2.statusCode} CT=${r2.headers['content-type']}`);
  } catch (e) { console.log(`    HEAD with Origin ERR: ${e.message}`); }

  // Test with Referer = playerUrl
  try {
    const r3 = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Referer': playerUrl },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`    HEAD with Referer: ${r3.statusCode} CT=${r3.headers['content-type']}`);
  } catch (e) { console.log(`    HEAD with Referer ERR: ${e.message}`); }

  // Test GET with Range
  try {
    const r4 = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Referer': playerUrl, 'Origin': BASE, Range: 'bytes=0-1023' },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`    GET Range w/ all: ${r4.statusCode} CT=${r4.headers['content-type']} bodylen=${r4.body.length}`);
    if (r4.statusCode === 200 || r4.statusCode === 206) {
      console.log(`      First 100 chars: ${r4.body.slice(0, 100)}`);
    }
  } catch (e) { console.log(`    GET Range ERR: ${e.message}`); }
}

console.log('=== Getting fresh streams for movie 155 server 1icarus ===');
const r = await getStreams('155', 'movie', undefined, undefined, '1icarus');
console.log(`Status: ${r.statusCode}`);
const data = JSON.parse(r.serversBody);
console.log(`Links: ${data.links?.length || 0}`);
for (const link of (data.links || []).slice(0, 3)) {
  console.log(`\n  ${link.type} | res=${link.resolution} | format=${link.format}`);
  await testStream(link.link, r.playerUrl);
}

console.log('\n\n=== Getting fresh streams for movie 155 server 1orion ===');
const r2 = await getStreams('155', 'movie', undefined, undefined, '1orion');
const data2 = JSON.parse(r2.serversBody);
console.log(`Links: ${data2.links?.length || 0}`);
for (const link of (data2.links || []).slice(0, 2)) {
  console.log(`\n  ${link.type} | source=${link.source}`);
  await testStream(link.link, r2.playerUrl);
}
