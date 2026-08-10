// Test the full ZXC stream /backend_/embed/sentinel flow with real TMDB IDs
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

function generateFrontendToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512')
    .update(`${ts}:${SECRET}:${tmdbId}`)
    .digest('hex')
    .slice(0, 64);
  return { xt, rt: ts };
}

async function getEmbed(tmdbId, mediaType, season, episode, imdbId) {
  const { xt, rt } = generateFrontendToken(tmdbId);

  // Step 1: POST /backend/token
  const tokenBody = {
    [FIELD_MAP.id]: String(tmdbId),
    [FIELD_MAP.fToken]: xt,
    [FIELD_MAP.ts]: String(rt),
  };
  console.log('POST /backend/token body:', JSON.stringify(tokenBody));

  const tokenRes = await gotScraping.post(`${BASE}/backend/token`, {
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': BASE,
      'Referer': `${BASE}/embed/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}`,
    },
    body: JSON.stringify(tokenBody),
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  console.log(`POST /backend/token → ${tokenRes.statusCode}`);
  console.log(`Body: ${tokenRes.body.slice(0, 800)}`);

  if (tokenRes.statusCode !== 200) return null;

  let tokenJson;
  try { tokenJson = JSON.parse(tokenRes.body); } catch { return null; }

  const token = tokenJson[FIELD_MAP.token];
  const ts = tokenJson[FIELD_MAP.ts];
  if (!token || !ts) {
    console.log('Missing token/ts in response');
    return null;
  }
  console.log(`Got token: ${token.slice(0, 16)}... ts: ${ts}`);

  // Step 2: GET /backend_/embed/sentinel
  const params = new URLSearchParams();
  params.set(FIELD_MAP.id, String(tmdbId));
  params.set('b', mediaType);
  params.set(FIELD_MAP.ts, String(ts));
  params.set(FIELD_MAP.token, token);
  params.set(FIELD_MAP.fToken, xt);
  if (mediaType === 'tv') {
    params.set(FIELD_MAP.season, String(season));
    params.set(FIELD_MAP.episode, String(episode));
  }
  if (imdbId) params.set(FIELD_MAP.imdbId, imdbId);

  const sentinelUrl = `${BASE}/backend_/embed/sentinel?${params.toString()}`;
  console.log(`\nGET ${sentinelUrl.slice(0, 200)}...`);

  const sentinelRes = await gotScraping.get(sentinelUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/embed/${mediaType}/${tmdbId}${mediaType === 'tv' ? `/${season}/${episode}` : ''}`,
    },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  console.log(`GET sentinel → ${sentinelRes.statusCode}`);
  console.log(`Body: ${sentinelRes.body.slice(0, 1500)}`);

  if (sentinelRes.statusCode !== 200) return null;
  try { return JSON.parse(sentinelRes.body); } catch { return null; }
}

// Test cases
const TESTS = [
  { type: 'movie', tmdb: '155', name: 'The Dark Knight' },
  { type: 'movie', tmdb: '693134', name: 'Dune Part Two' },
  { type: 'movie', tmdb: '27205', name: 'Inception' },
  { type: 'tv', tmdb: '1396', s: 1, e: 1, name: 'Breaking Bad S01E01' },
  { type: 'tv', tmdb: '95479', s: 1, e: 1, name: 'Jujutsu Kaisen S01E01' },
  { type: 'tv', tmdb: '93405', s: 1, e: 1, name: 'Squid Game S01E01' },
];

for (const t of TESTS) {
  console.log('\n========================================');
  console.log(`TEST: ${t.name} (tmdb=${t.tmdb})`);
  console.log('========================================');
  try {
    const r = await getEmbed(t.tmdb, t.type, t.s, t.e, t.imdb);
    console.log('FINAL:', JSON.stringify(r, null, 2));
  } catch (e) {
    console.log(`Error: ${e.message}`);
    if (e.response) {
      console.log(`Status: ${e.response.statusCode}`);
      console.log(`Body: ${(e.response.body || '').slice(0, 500)}`);
    }
  }
}
