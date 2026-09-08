import { gotScraping } from 'got-scraping';

// Fetch the watch page and find what JS chunks it loads
const r = await gotScraping('https://raflixx.vercel.app/watch/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Find ALL JS chunk URLs
const jsChunks = [...r.body.matchAll(/\/assets\/[a-z0-9._-]+\.js/gi)];
console.log('JS chunks on watch page:');
for (const m of [...new Set(jsChunks.map(m => m[0]))]) console.log('  ', m);

// Also look for modulepreload
const preloads = [...r.body.matchAll(/modulepreload[^>]*href="([^"]+)"/gi)];
console.log('\nModule preloads:');
for (const m of preloads) console.log('  ', m[1]);

// Find the watch page specific chunk
const watchChunks = [...r.body.matchAll(/\/assets\/([^"'\s]*watch[^"'\s]*\.js)/gi)];
console.log('\nWatch-specific chunks:');
for (const m of watchChunks) console.log('  ', m[0]);

// Look for ALL script sources
const scripts = [...r.body.matchAll(/<script[^>]*src="([^"]+)"/gi)];
console.log('\nAll scripts:');
for (const m of scripts) console.log('  ', m[1]);

// Check if there are lazy-loaded chunks for the watch page
const lazyChunks = [...r.body.matchAll(/["'`]\/assets\/([^"'`]+\.js)["'`]/g)];
console.log('\nAll asset references:');
for (const m of [...new Set(lazyChunks.map(m => m[1]))]) console.log('  ', m);
