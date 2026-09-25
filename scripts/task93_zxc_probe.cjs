// Task 93: live probe of zxcstream token endpoint 302 behavior.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const SECRET = '23423653';
const FIELD_MAP = {
  id: 'a7f39c821d604e5b9c7143f36e1547b',
  fToken: 'e83c4b719a52d8f3136052479c1635a',
  ts: '61d9a5274c8e3b29af75d6384c291e6',
  path: '6b491e7253ad8f14d392e7561a9384c',
  mediaType: 'c285f91ab306d281e947a35632e816b',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const BASES = ['https://player.zxcprime.xyz', 'https://player.zxcstream.xyz'];
const ROUTES = ['/backend/ololmo', '/backend/burat', '/backend/bugok', '/backend/abaygagoka'];

function fetchRaw(url, opts = {}, redirects = 0) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: opts.method || 'GET',
      headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opts.headers || {}),
      timeout: opts.timeout || 12000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        const next = new URL(res.headers.location, u).href;
        res.resume();
        const method = (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) ? 'GET' : (opts.method || 'GET');
        return fetchRaw(next, { ...opts, method, headers: method === 'GET' ? { 'User-Agent': UA, Accept: '*/*', Referer: opts.headers?.Referer } : opts.headers }, redirects + 1)
          .then(r2 => resolve({ ...r2, followedFrom: url, redirectChain: [next].concat(r2.redirectChain || []) }));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message, headers: {} }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

(async () => {
  const ts = Date.now();
  const xt = crypto.createHash('sha512').update(`${ts}:${SECRET}:27205`).digest('hex').slice(0, 64);
  const body = {
    [FIELD_MAP.id]: '27205', [FIELD_MAP.fToken]: xt, [FIELD_MAP.ts]: ts,
    [FIELD_MAP.path]: BASES[0] + '/embed/movie/27205', [FIELD_MAP.mediaType]: 'movie',
  };
  for (const base of BASES) {
    for (const route of ROUTES) {
      const r = await fetchRaw(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Origin: base, Referer: base + '/embed/movie/27205' },
        body: JSON.stringify(body), timeout: 12000,
      });
      console.log(`POST ${base}${route} -> ${r.status}${r.followedFrom ? ' (followed: ' + String(r.followedFrom).slice(0, 100) + ')' : ''}`);
      if (r.status === 200) {
        console.log('  body:', r.body.slice(0, 300));
      }
    }
  }
  process.exit(0);
})();
