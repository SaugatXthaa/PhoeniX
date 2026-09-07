import { gotScraping } from 'got-scraping';

// TanStack Start uses POST to the same URL with special headers
// Try POST to /movie/27205 with server function headers
const tests = [
  { method: 'POST', url: 'https://www.imdbplay.tech/movie/27205', headers: { 'Content-Type': 'application/json', 'X-Server-Function': 'true' }, body: '{}' },
  { method: 'POST', url: 'https://www.imdbplay.tech/api/movie/27205', headers: { 'Accept': 'application/json' } },
  { method: 'GET', url: 'https://www.imdbplay.tech/api/movie/27205/servers', headers: { 'Accept': 'application/json' } },
];

for (const t of tests) {
  try {
    const r = await gotScraping(t.url, {
      method: t.method,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', ...t.headers },
      ...(t.body && { body: t.body }),
      timeout: { request: 8000 }, throwHttpErrors: false,
    });
    if (r.statusCode !== 404) {
      console.log(`${t.method} ${t.url} → ${r.statusCode} (${r.body.length}b)`);
      if (r.body.length < 500) console.log('  ', r.body.slice(0, 200));
    }
  } catch {}
}

// Also try the TSS server function endpoint
const tssRes = await gotScraping.post('https://www.imdbplay.tech/movie/27205', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Content-Type': 'application/json',
    'Accept': 'text/x-tanstack-server-fn',
  },
  body: JSON.stringify({ serverId: 1 }),
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log(`\nTSS POST: ${tssRes.statusCode} (${tssRes.body.length}b)`);
if (tssRes.body.length < 500) console.log('  ', tssRes.body.slice(0, 200));

// Try fetching with different Accept headers
for (const accept of ['application/json', 'text/x-tanstack-server-fn', 'application/x-server-fn']) {
  const r = await gotScraping('https://www.imdbplay.tech/movie/27205', {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': accept, 'X-Requested-With': 'XMLHttpRequest' },
    timeout: { request: 8000 }, throwHttpErrors: false,
  });
  if (r.statusCode !== 200 || r.body.length < 5000) {
    console.log(`\nAccept: ${accept} → ${r.statusCode} (${r.body.length}b)`);
    if (r.body.length < 500) console.log('  ', r.body.slice(0, 200));
  }
}
