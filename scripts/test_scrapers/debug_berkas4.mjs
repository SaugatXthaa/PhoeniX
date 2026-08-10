// Test Berkas API status across multiple content with proper error handling
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

async function testBerkasApi(tmdbId, mediaType, season, episode) {
  const playerUrl = `${BASE}/player/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}?server=1berkas&subLang=english`;

  let details;
  try {
    const detailsRes = await gotScraping.get(`${BASE}/backend/tmdb/details/${mediaType}/${tmdbId}?language=en-US`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
    });
    if (detailsRes.statusCode !== 200) return { api: `details:${detailsRes.statusCode}` };
    details = JSON.parse(detailsRes.body);
  } catch (e) { return { api: `details_err:${e.message.slice(0, 50)}` }; }

  await sleep(800);
  const { xt, rt } = genToken(String(tmdbId));
  let tj;
  try {
    const tokenRes = await gotScraping.post(`${BASE}/backend/token__`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': playerUrl },
      body: JSON.stringify({ [FIELD_MAP.id]: String(tmdbId), [FIELD_MAP.fToken]: xt, [FIELD_MAP.ts]: String(rt) }),
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
    });
    if (tokenRes.statusCode !== 200) return { api: `token:${tokenRes.statusCode}` };
    tj = JSON.parse(tokenRes.body);
  } catch (e) { return { api: `token_err:${e.message.slice(0, 50)}` }; }

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
  if (mediaType === 'tv') { params.set(FIELD_MAP.season, String(season)); params.set(FIELD_MAP.episode, String(episode)); }
  if (details.imdb_id) params.set(FIELD_MAP.imdbId, details.imdb_id);

  try {
    const serversRes = await gotScraping.get(`${BASE}/backend_/servers/1berkas?${params.toString()}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
      timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
    });

    if (serversRes.statusCode === 200) {
      const d = JSON.parse(serversRes.body);
      return { api: 'ok', links: d.links?.length || 0, firstUrl: d.links?.[0]?.link };
    }
    return { api: `servers:${serversRes.statusCode}`, body: serversRes.body?.slice(0, 100) };
  } catch (e) { return { api: `servers_err:${e.message.slice(0, 50)}` }; }
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
  process.stdout.write(`${t.name}: `);
  const r = await testBerkasApi(t.tmdb, t.type, t.s, t.e);
  if (r.api === 'ok') {
    console.log(`OK (links=${r.links})`);
    if (r.firstUrl) console.log(`  URL: ${r.firstUrl.slice(0, 100)}`);
  } else {
    console.log(`FAIL (${r.api})`);
    if (r.body) console.log(`  body: ${r.body}`);
  }
  await sleep(2000);
}
