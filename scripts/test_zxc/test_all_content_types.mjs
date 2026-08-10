// Test anime + kdrama streams, and check dub/sub handling
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

async function getStreams(tmdbId, mediaType, season, episode, serverId, dubCode, dubType) {
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
  if (dubCode && dubType !== undefined) {
    params.set('dubCode', dubCode);
    params.set('dubType', String(dubType));
  }

  const serversRes = await gotScraping.get(`${BASE}/backend_/servers/${serverId}?${params.toString()}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
  });
  return { body: serversRes.body, statusCode: serversRes.statusCode, playerUrl, details };
}

const TESTS = [
  // Movies
  { type: 'movie', tmdb: '155', name: 'The Dark Knight' },
  { type: 'movie', tmdb: '27205', name: 'Inception' },
  { type: 'movie', tmdb: '693134', name: 'Dune Part Two' },
  // TV/Series
  { type: 'tv', tmdb: '1396', s: 1, e: 1, name: 'Breaking Bad S01E01' },
  // Anime (Jujutsu Kaisen, very popular)
  { type: 'tv', tmdb: '95479', s: 1, e: 1, name: 'Jujutsu Kaisen S01E01' },
  // K-Drama (Squid Game)
  { type: 'tv', tmdb: '93405', s: 1, e: 1, name: 'Squid Game S01E01' },
  // Anime movie (Demon Slayer: Mugen Train)
  { type: 'movie', tmdb: '745058', name: 'Demon Slayer Mugen Train' },
];

const SERVERS = ['1orion', '1icarus', '1berkas', '1resshin', '1daedalus', '1athena', '1sentinel'];

for (const t of TESTS) {
  console.log(`\n\n========================================`);
  console.log(`TEST: ${t.name} (tmdb=${t.tmdb})`);
  console.log('========================================');
  for (const s of SERVERS) {
    try {
      const r = await getStreams(t.tmdb, t.type, t.s, t.e, s);
      let linksCount = 0, dubsCount = 0;
      try {
        const d = JSON.parse(r.body);
        if (d.success && Array.isArray(d.links)) {
          linksCount = d.links.length;
          dubsCount = Array.isArray(d.dubs) ? d.dubs.length : 0;
        }
        console.log(`  ${s.padEnd(11)} → ${r.statusCode} | links=${linksCount} dubs=${dubsCount}${dubsCount > 0 ? ' (dubs: ' + (d.dubs?.slice(0,5).map(x => `${x.lang}/${x.type}`).join(', ')) + ')' : ''}`);
      } catch {
        console.log(`  ${s.padEnd(11)} → ${r.statusCode} | body: ${r.body.slice(0, 100)}`);
      }
    } catch (e) { console.log(`  ${s.padEnd(11)} ERR: ${e.message}`); }
    await sleep(1500);
  }
}
