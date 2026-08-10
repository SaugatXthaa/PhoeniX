// Test Berkas across multiple content types to see when it returns 500/404
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

async function testBerkas(tmdbId, mediaType, season, episode) {
  const playerUrl = `${BASE}/player/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}?server=1berkas&subLang=english`;

  const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/${mediaType}/${tmdbId}?language=en-US`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (detailsRes.statusCode !== 200) return { status: `details ${detailsRes.statusCode}` };
  const details = JSON.parse(detailsRes.body);

  await sleep(800);

  const { xt, rt } = genToken(String(tmdbId));
  const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': playerUrl },
    body: JSON.stringify({ [FIELD_MAP.id]: String(tmdbId), [FIELD_MAP.fToken]: xt, [FIELD_MAP.ts]: String(rt) }),
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (tokenRes.statusCode !== 200) return { status: `token ${tokenRes.statusCode}` };
  const tj = JSON.parse(tokenRes.body);

  await sleep(1200);

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

  const serversRes = await gotScraping.get(`${BASE}/backend_/servers/1berkas?${params.toString()}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
  });

  let linksCount = 0, sampleUrl = null;
  if (serversRes.statusCode === 200) {
    try {
      const d = JSON.parse(serversRes.body);
      if (d.success && Array.isArray(d.links)) {
        linksCount = d.links.length;
        sampleUrl = d.links[0]?.link;
      }
    } catch {}
  }

  return {
    status: serversRes.statusCode,
    links: linksCount,
    sample: sampleUrl?.slice(0, 80),
    body: serversRes.statusCode !== 200 ? serversRes.body.slice(0, 200) : null,
  };
}

const TESTS = [
  { tmdb: '155', type: 'movie', name: 'The Dark Knight' },
  { tmdb: '27205', type: 'movie', name: 'Inception' },
  { tmdb: '693134', type: 'movie', name: 'Dune Part Two' },
  { tmdb: '1396', type: 'tv', s: 1, e: 1, name: 'Breaking Bad S01E01' },
  { tmdb: '95479', type: 'tv', s: 1, e: 1, name: 'Jujutsu Kaisen S01E01' },
  { tmdb: '93405', type: 'tv', s: 1, e: 1, name: 'Squid Game S01E01' },
];

for (const t of TESTS) {
  console.log(`\n${t.name}:`);
  const r = await testBerkas(t.tmdb, t.type, t.s, t.e);
  console.log(`  Berkas: status=${r.status} links=${r.links}`);
  if (r.sample) console.log(`  Sample URL: ${r.sample}`);
  if (r.body) console.log(`  Body: ${r.body}`);
  await sleep(2000);
}

// Now test a Berkas stream URL directly to see if it returns 403/404
console.log('\n\n=== Test Berkas stream URL playback ===');
// Get fresh Berkas streams for Jujutsu Kaisen
const r = await testBerkas('95479', 'tv', 1, 1);
if (r.links > 0) {
  // Re-fetch to get the actual URL
  const playerUrl = `${BASE}/player/tv/95479/1/1?server=1berkas&subLang=english`;
  const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/tv/95479?language=en-US`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const details = JSON.parse(detailsRes.body);
  await sleep(1000);
  const { xt, rt } = genToken('95479');
  const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': playerUrl },
    body: JSON.stringify({ [FIELD_MAP.id]: '95479', [FIELD_MAP.fToken]: xt, [FIELD_MAP.ts]: String(rt) }),
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const tj = JSON.parse(tokenRes.body);
  await sleep(1200);
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
  if (details.imdb_id) params.set(FIELD_MAP.imdbId, details.imdb_id);

  const serversRes = await gotScraping.get(`${BASE}/backend_/servers/1berkas?${params.toString()}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
  });
  const d = JSON.parse(serversRes.body);
  for (const link of (d.links || []).slice(0, 2)) {
    console.log(`\n  Stream: ${link.type} | res=${link.resolution}`);
    console.log(`  URL: ${link.link.slice(0, 120)}`);
    try {
      const r = await gotScraping.get(link.link, {
        headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*', 'Range': 'bytes=0-1023' },
        timeout: { request: 15000 }, throwHttpErrors: false, http2: true, followRedirect: true,
      });
      console.log(`  Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body?.length || 0}`);
      if (r.statusCode === 200 || r.statusCode === 206) {
        console.log(`  First 200 chars: ${r.body.slice(0, 200)}`);
      } else if (r.statusCode === 403 || r.statusCode === 404) {
        console.log(`  Body: ${r.body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`  ERR: ${e.message}`);
    }
    await sleep(1000);
  }
}
