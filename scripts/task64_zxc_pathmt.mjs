// Task 64: bugok with path/mediaType fields (old backend contract)
const crypto = await import('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://player.zxcprime.xyz';
const SECRET = '23423653';
const FM = {
  id: 'a7f39c821d604e5b9c7143f36e1547b', fToken: 'e83c4b719a52d8f3136052479c1635a', ts: '61d9a5274c8e3b29af75d6384c291e6',
  path: '6b491e7253ad8f14d392e7561a9384c', mediaType: 'c285f91ab306d281e947a35632e816b',
  token: 'c492f7a183d6502b1e7436c538a716d', season: 'd8427b59ce30684a2f957c3613e85b', episode: '91c6e4a728bd503d1f785c92346b713d', imdbId: 'f35a8c19d674b3265e871c4933a725f',
};

const pagePath = BASE + '/embed/movie/27205';

async function bugok(body, label) {
  const r = await fetch(BASE + '/backend/bugok', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Origin': BASE, 'Referer': pagePath },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const t = await r.text();
  console.log(`${label}: ${r.status} :: ${t.slice(0, 240)}`);
  return { status: r.status, body: t };
}

const ts = Date.now();
const fToken = crypto.createHash('sha512').update(`${ts}:${SECRET}:27205`).digest('hex').slice(0, 64);
const base = { [FM.id]: '27205', [FM.fToken]: fToken, [FM.ts]: ts };

let r1 = await bugok({ ...base, [FM.path]: pagePath, [FM.mediaType]: 'movie' }, 'path+mediaType');
if (r1.status !== 200) {
  r1 = await bugok({ ...base, [FM.path]: '/embed/movie/27205', [FM.mediaType]: 'movie' }, 'relpath+mediaType');
}
if (r1.status !== 200) {
  await bugok({ ...base, [FM.path]: pagePath, [FM.mediaType]: 'movie', [FM.imdbId]: 'tt1375666' }, 'path+mediaType+imdb');
}

// If 200 → proceed to sentinel
async function sentinel(tokJson) {
  const token = tokJson[FM.token] ?? tokJson.token;
  const serverTs = tokJson[FM.ts] ?? tokJson.ts;
  const q = new URLSearchParams();
  q.set(FM.id, '27205'); q.set('b', 'movie'); q.set(FM.ts, String(serverTs));
  q.set(FM.token, String(token)); q.set(FM.fToken, fToken);
  q.set(FM.imdbId, 'tt1375666');
  const s = await fetch(BASE + '/backend_/embed/sentinel?' + q.toString(), {
    headers: { 'User-Agent': UA, 'Referer': pagePath }, signal: AbortSignal.timeout(15000),
  });
  const st = await s.text();
  console.log('sentinel:', s.status, '::', st.slice(0, 300));
  return st;
}
try {
  const j = JSON.parse(r1.body);
  if (r1.status === 200) await sentinel(j);
} catch { }
