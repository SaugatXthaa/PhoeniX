import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find serverFn definitions
const serverFns = [...js.matchAll(/serverFnMeta:\s*\{[^}]+\}/gi)];
console.log('Server function metadata:');
for (const m of serverFns.slice(0, 10)) {
  console.log('  ', m[0].slice(0, 200));
}

// Find server function calls (createServerFn)
const createFns = [...js.matchAll(/createServerFn\([^)]{0,300}\)/gi)];
console.log('\ncreateServerFn calls:');
for (const m of createFns.slice(0, 10)) {
  console.log('  ', m[0].slice(0, 200));
}

// Find the actual server-side API route handlers
// TanStack Start uses /api/ routes for server functions
const apiRoutes = [...js.matchAll(/["'`](\/api\/[^"'`]+)["'`]/gi)];
console.log('\nAPI routes:');
for (const m of [...new Set(apiRoutes.map(m => m[1]))]) {
  console.log('  ', m);
}

// Look for fetch calls with relative URLs that could be server function calls
const relFetches = [...js.matchAll(/fetch\(`([^`]+)`/gi)];
console.log('\nRelative fetch URLs:');
for (const m of [...new Set(relFetches.map(m => m[1]))]) {
  console.log('  ', m);
}

// Try fetching /api/ to see what's available
console.log('\n=== Testing /api/ endpoints ===');
const testPaths = [
  '/api/stream/movie/27205',
  '/api/sources/movie/27205',
  '/api/play/movie/27205',
  '/api/video/movie/27205',
  '/api/watch/movie/27205',
  '/api/movie/27205',
  '/api/movies/27205',
];
for (const p of testPaths) {
  const res = await gotScraping(`https://www.imdbplay.tech${p}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
    timeout: { request: 5000 }, throwHttpErrors: false,
  });
  if (res.statusCode !== 404) {
    console.log(`  ${p} → ${res.statusCode} (${res.body.length}b)`);
    if (res.body.length < 500) console.log('    ', res.body.slice(0, 200));
  }
}
