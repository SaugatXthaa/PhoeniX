// Task 64: zxcprime full browser-parallel flow with cookie jar (details → bugok)
const crypto = await import('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://player.zxcprime.xyz';
const SECRET = '23423653';
const FM = { id: 'a7f39c821d604e5b9c7143f36e1547b', fToken: 'e83c4b719a52d8f3136052479c1635a', ts: '61d9a5274c8e3b29af75d6384c291e6' };

// cookie jar
let jar = {};
function absorb(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}
function cookieHeader() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

const pagePath = BASE + '/embed/movie/27205';

// 1. fetch the embed page itself (sets cookies)
const page = await fetch(pagePath, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
absorb(page);
await page.text();
console.log('page cookies:', Object.keys(jar));

// 2. GET tmdb details
const det = await fetch(BASE + '/backend/tmdb/details/movie/27205?language=en-US', {
  headers: { 'User-Agent': UA, 'Referer': pagePath, 'Cookie': cookieHeader() }, signal: AbortSignal.timeout(15000),
});
absorb(det);
const detBody = await det.text();
console.log('details:', det.status, detBody.slice(0, 260));

// 3. POST bugok with cookies + details-derived fields
const ts = Date.now();
const fToken = crypto.createHash('sha512').update(`${ts}:${SECRET}:27205`).digest('hex').slice(0, 64);
const post = await fetch(BASE + '/backend/bugok', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Origin': BASE, 'Referer': pagePath, 'Cookie': cookieHeader() },
  body: JSON.stringify({ [FM.id]: '27205', [FM.fToken]: fToken, [FM.ts]: ts }),
  signal: AbortSignal.timeout(15000),
});
absorb(post);
const postBody = await post.text();
console.log('bugok with cookies:', post.status, postBody.slice(0, 300));

// 4. variants: numeric id, number ts
for (const [label, body] of [
  ['num-id', { [FM.id]: 27205, [FM.fToken]: fToken, [FM.ts]: ts }],
  ['str-ts', { [FM.id]: '27205', [FM.fToken]: fToken, [FM.ts]: String(ts) }],
  ['id+token-typo-guard', { id: '27205', fToken, ts }],
]) {
  const p2 = await fetch(BASE + '/backend/bugok', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Origin': BASE, 'Referer': pagePath, 'Cookie': cookieHeader() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const t2 = await p2.text();
  console.log(`${label}: ${p2.status} :: ${t2.slice(0, 200)}`);
}
