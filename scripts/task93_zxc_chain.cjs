// Task 93: full zxcstream chain probe on the NEW token route.
const crypto = require('crypto'), http = require('http'), https = require('https');
const SECRET = '23423653';
const FM = {
  id: 'a7f39c821d604e5b9c7143f36e1547b', fToken: 'e83c4b719a52d8f3136052479c1635a',
  ts: '61d9a5274c8e3b29af75d6384c291e6', token: 'c492f7a183d6502b1e7436c538a716d',
  season: 'd8427b59ce30684a2f957c3613e85b', episode: '91c6e4a728bd503d1f785c92346b713d',
  imdbId: 'f35a8c19d674b3265e871c4933a725f', path: '6b491e7253ad8f14d392e7561a9384c',
  mediaType: 'c285f91ab306d281e947a35632e816b',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const BASE = process.argv[2] || 'https://player.zxcprime.xyz';
const ROUTE = '/backend_/tanginamogagotarantado';

function raw(url, opts = {}) {
  return new Promise((res) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opts.headers || {}), timeout: 12000,
    }, r => { const c = []; r.on('data', x => c.push(x)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c).toString('utf8'), headers: r.headers })); });
    req.on('error', e => res({ status: 0, body: 'ERR ' + e.message, headers: {} }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

(async () => {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:27205`).digest('hex').slice(0, 64);
  // NOTE: 3-field body = 400 "Invalid request" (measured). The new route
  // STILL requires path + mediaType (old 5-field contract) — keep them.
  const body = {};
  body[FM.id] = '27205'; body[FM.fToken] = xt; body[FM.ts] = ts;
  body[FM.path] = BASE + '/embed/movie/27205'; body[FM.mediaType] = 'movie';
  const t = await raw(BASE + ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Origin: BASE, Referer: BASE + '/embed/movie/27205' },
    body: JSON.stringify(body), timeout: 12000,
  });
  console.log('token(3-field):', t.status, t.body.slice(0, 200));
  if (t.status !== 200) process.exit(1);
  const j = JSON.parse(t.body);
  const tok = j[FM.token] || j.token;
  const serverTs = j[FM.ts] || j.ts;
  const q = new URLSearchParams();
  q.set(FM.id, '27205'); q.set('b', 'movie'); q.set(FM.ts, String(serverTs)); q.set(FM.token, String(tok)); q.set(FM.fToken, xt);
  for (let i = 1; i <= 3; i++) {
    const s = await raw(BASE + '/backend_/embed/sentinel?' + q.toString(), {
      headers: {
        Referer: BASE + '/embed/movie/27205', Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
      }, timeout: 12000,
    });
    console.log('sentinel try ' + i + ':', s.status, s.body.slice(0, 240));
    if (s.status === 200) break;
  }
  process.exit(0);
})();
