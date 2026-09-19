// Task 64: zxcprime end-to-end token → sentinel → embed → media extraction
const crypto = await import('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://player.zxcprime.xyz';
const SECRET = '23423653';
const FIELD_MAP = {
  id: 'a7f39c821d604e5b9c7143f36e1547b', fToken: 'e83c4b719a52d8f3136052479c1635a', ts: '61d9a5274c8e3b29af75d6384c291e6',
  token: 'c492f7a183d6502b1e7436c538a716d', season: 'd8427b59ce30684a2f957c3613e85b', episode: '91c6e4a728bd503d1f785c92346b713d',
  imdbId: 'f35a8c19d674b3265e871c4933a725f',
};

async function flow(tmdbId, type, season, episode, imdbId) {
  const ts = Date.now();
  const fToken = crypto.createHash('sha512').update(`${ts}:${SECRET}:${String(tmdbId)}`).digest('hex').slice(0, 64);
  const pagePath = `${BASE}/embed/${type}/${tmdbId}`;
  const tokRes = await fetch(BASE + '/backend/bugok', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Referer': pagePath, 'Origin': BASE },
    body: JSON.stringify({ [FIELD_MAP.id]: String(tmdbId), [FIELD_MAP.fToken]: fToken, [FIELD_MAP.ts]: ts }),
    signal: AbortSignal.timeout(15000),
  });
  console.log('token POST:', tokRes.status);
  if (!tokRes.ok) return null;
  const j = await tokRes.json();
  const token = j[FIELD_MAP.token] || j.token;
  const serverTs = j[FIELD_MAP.ts] || j.ts;
  console.log('token:', token ? token.slice(0, 30) + '...' : null, 'ts:', serverTs);

  const q = new URLSearchParams();
  q.set(FIELD_MAP.id, String(tmdbId));
  q.set('b', type);
  q.set(FIELD_MAP.ts, String(serverTs));
  q.set(FIELD_MAP.token, String(token));
  q.set(FIELD_MAP.fToken, fToken);
  if (type === 'tv' && season) { q.set(FIELD_MAP.season, String(season)); q.set(FIELD_MAP.episode, String(episode || 1)); }
  if (imdbId) q.set(FIELD_MAP.imdbId, String(imdbId));
  const sRes = await fetch(BASE + '/backend_/embed/sentinel?' + q.toString(), {
    headers: { 'User-Agent': UA, 'Referer': pagePath }, signal: AbortSignal.timeout(15000),
  });
  console.log('sentinel:', sRes.status);
  const sData = await sRes.json().catch(() => null);
  console.log('sentinel body:', JSON.stringify(sData).slice(0, 300));
  return sData?.embed || null;
}

const movieEmb = await flow('27205', 'movie', null, null, 'tt1375666');
console.log('MOVIE embed:', movieEmb);
if (movieEmb) {
  // fetch the embed page and look for media urls
  const r = await fetch(movieEmb, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const html = await r.text();
  console.log('embed page:', r.status, 'len', html.length, 'final url:', r.url.slice(0, 100));
  const media = [...html.matchAll(/https?:\/\/[^"'\s\\<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s\\<>]*)?/gi)].map(m => m[0]);
  console.log('media urls:', media.slice(0, 5));
  if (!media.length) console.log('head:', html.slice(0, 400));
}

console.log();
const tvEmb = await flow('1396', 'tv', 1, 1, 'tt0903747');
console.log('TV embed:', tvEmb);
if (tvEmb) {
  const r = await fetch(tvEmb, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const html = await r.text();
  console.log('embed page:', r.status, 'len', html.length, 'final url:', r.url.slice(0, 100));
  const media = [...html.matchAll(/https?:\/\/[^"'\s\\<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s\\<>]*)?/gi)].map(m => m[0]);
  console.log('media urls:', media.slice(0, 5));
  if (!media.length) console.log('head:', html.slice(0, 400));
}
