// Simplified Berkas test — just check API status and stream URL
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

async function getBerkas(tmdbId, mediaType, season, episode) {
  const playerUrl = `${BASE}/player/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}?server=1berkas&subLang=english`;

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

  const serversRes = await gotScraping.get(`${BASE}/backend_/servers/1berkas?${params.toString()}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': playerUrl },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true,
  });

  console.log(`  ${tmdbId} (${mediaType}): API ${serversRes.statusCode}`);
  if (serversRes.statusCode === 200) {
    try {
      const d = JSON.parse(serversRes.body);
      console.log(`    success=${d.success} links=${d.links?.length || 0}`);
      if (d.links?.[0]) {
        console.log(`    First link: type=${d.links[0].type} res=${d.links[0].resolution}`);
        console.log(`    URL: ${d.links[0].link.slice(0, 120)}`);
        return d.links[0].link;
      }
    } catch (e) { console.log(`    parse err: ${e.message}`); }
  } else if (serversRes.body) {
    console.log(`    body: ${serversRes.body.slice(0, 200)}`);
  }
  return null;
}

// Test multiple content
const link1 = await getBerkas('95479', 'tv', 1, 1);  // Jujutsu Kaisen
await sleep(2000);
const link2 = await getBerkas('1396', 'tv', 1, 1);   // Breaking Bad
await sleep(2000);
const link3 = await getBerkas('155', 'movie');        // Dark Knight

// Test the stream URL — try with a short timeout first, then longer
for (const [label, url] of [['JJK', link1], ['BB', link2], ['TDK', link3]]) {
  if (!url) continue;
  console.log(`\n=== Test ${label} stream URL ===`);
  console.log(`URL: ${url.slice(0, 150)}`);

  // Check the URL structure
  const urlObj = new URL(url);
  console.log(`Host: ${urlObj.hostname}`);
  console.log(`Path: ${urlObj.pathname}`);

  // Try with 30s timeout (Berkas streams are slow to respond)
  try {
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
      timeout: { request: 30000 }, throwHttpErrors: false, http2: true, followRedirect: true,
      responseType: 'text',
    });
    console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body?.length || 0}`);
    if (r.statusCode === 200 || r.statusCode === 206) {
      console.log(`First 300: ${r.body.slice(0, 300)}`);
    } else {
      console.log(`Body: ${r.body?.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`ERR: ${e.message}`);
  }
  await sleep(2000);
}
