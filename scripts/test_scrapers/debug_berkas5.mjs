// Quick Berkas API check with short timeouts
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const SECRET = '24356351231432574635345245245252324';
const FM = { id: 'c81f7a42d9e253b16f408', fToken: '9e3c7bd314af65281d0e49b73', ts: '54d8b21fc9a374e60b1fd', token: 'b7f18e4c25d963a50ef81c4a9', title: '2af9c71de384b5630c91e', year: 'f0b34e8d61c6a9275a14f', season: 'd41e8c6b259af73510fc48a7e', episode: '8b7d13fa8e620c9541d8e7bc2', imdbId: '6e2af5c97d19840b3f81a6d54' };

async function testServer(tmdbId, mediaType, season, episode, serverId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);

  const tokenRes = await gotScraping.post('https://player.zxcstream.xyz/backend/token__', {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': 'https://player.zxcstream.xyz', 'Referer': 'https://player.zxcstream.xyz/player/movie/155' },
    body: JSON.stringify({ [FM.id]: String(tmdbId), [FM.fToken]: xt, [FM.ts]: String(ts) }),
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  if (tokenRes.statusCode !== 200) return `${serverId}:token:${tokenRes.statusCode}`;
  const tj = JSON.parse(tokenRes.body);

  const params = new URLSearchParams();
  params.set(FM.id, String(tmdbId));
  params.set('b', mediaType);
  params.set(FM.ts, String(tj[FM.ts]));
  params.set(FM.token, tj[FM.token]);
  params.set(FM.fToken, xt);
  params.set(FM.title, 'Test');
  params.set(FM.year, '2020');
  params.set('date', '2020-01-01');
  if (mediaType === 'tv') { params.set(FM.season, String(season)); params.set(FM.episode, String(episode)); }

  const serverRes = await gotScraping.get(`https://player.zxcstream.xyz/backend_/servers/${serverId}?${params.toString()}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': 'https://player.zxcstream.xyz/player/movie/155' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (serverRes.statusCode !== 200) return `${serverId}:${serverRes.statusCode}:${serverRes.body.slice(0, 80)}`;
  try {
    const d = JSON.parse(serverRes.body);
    return `${serverId}:ok:links=${d.links?.length || 0}`;
  } catch { return `${serverId}:parse_err`; }
}

// Test all servers for The Dark Knight
console.log('=== The Dark Knight (movie 155) ===');
for (const s of ['1orion', '1icarus', '1berkas', '1resshin', '1daedalus', '1athena', '1sentinel']) {
  try {
    const r = await testServer('155', 'movie', undefined, undefined, s);
    console.log(`  ${r}`);
  } catch (e) {
    console.log(`  ${s}: ERR ${e.message.slice(0, 50)}`);
  }
  await new Promise(r => setTimeout(r, 1500));
}
