import { gotScraping } from 'got-scraping';

// Download the vendor-tanstack JS
const r = await gotScraping('https://raflixx.vercel.app/assets/vendor-tanstack-y51MJAaR.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('vendor-tanstack size:', r.body.length);

// Search for server function / createServerFn patterns
const serverFns = [...r.body.matchAll(/createServerFn[^;]{0,300}/g)];
console.log('createServerFn calls:', serverFns.length);
for (const m of serverFns.slice(0, 3)) console.log('  ', m[0].slice(0, 200));

// Search for fetch/stream patterns
const fetches = [...r.body.matchAll(/fetch\([^)]+\)/g)];
console.log('Fetch calls:', fetches.length);

// Also check the main index.js for server function definitions
const r2 = await gotScraping('https://raflixx.vercel.app/assets/index-1tmTi0g4.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Search for server function URLs that return stream data
// The server function might be at /api/media/${type}/${id} with a specific header
// Let me try POST to /api/media with a body
console.log('\n=== Try POST to /api/media ===');
const postRes = await gotScraping.post('https://raflixx.vercel.app/api/media/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'stream', serverId: 1 }),
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log('POST status:', postRes.statusCode, '| size:', postRes.body.length);
if (postRes.body.length < 500) console.log('Body:', postRes.body.slice(0, 200));

// Try the watch page route as an API
console.log('\n=== Try /watch/ as API ===');
const watchRes = await gotScraping('https://raflixx.vercel.app/watch/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log('Watch page:', watchRes.statusCode, '| size:', watchRes.body.length);

// Look for ALL API endpoints that might return stream data
// by scanning the JS for fetch calls with "stream" or "source" or "server"
const streamApis = [...r2.body.matchAll(/["'`](\/api\/[^"'`]*(?:stream|source|server|play|video|embed|watch|quality)[^"'`]*)["'`]/gi)];
console.log('\nStream-related API paths:');
for (const m of [...new Set(streamApis.map(m => m[1]))]) console.log('  ', m);

// Look for iframe embed URLs in the JS
const embedUrls = [...r2.body.matchAll(/["'`](https?:\/\/[^"'`]*(?:embed|player|stream|video|watch|play)[^"'`]*)["'`]/gi)];
console.log('\nEmbed/stream URLs in JS:');
for (const m of [...new Set(embedUrls.map(m => m[1]))]) {
  if (!m.includes('google') && !m.includes('youtube') && !m.includes('vercel')) {
    console.log('  ', m);
  }
}

// Look for the actual streaming source — maybe it's a different API path
console.log('\n=== Try additional API paths ===');
const paths = [
  '/api/stream/movie/27205',
  '/api/sources/movie/27205', 
  '/api/play/movie/27205',
  '/api/video/movie/27205',
  '/api/embed/movie/27205',
  '/api/server/movie/27205',
  '/api/watch/movie/27205',
  '/api/links/movie/27205',
  '/api/episode/movie/27205',
  '/api/quality/movie/27205',
];

for (const p of paths) {
  const r3 = await gotScraping(`https://raflixx.vercel.app${p}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
    timeout: { request: 3000 }, throwHttpErrors: false,
  });
  if (r3.statusCode !== 404) {
    console.log(`  ${p} → ${r3.statusCode} (${r3.body.length}b): ${r3.body.slice(0, 100)}`);
  }
}
