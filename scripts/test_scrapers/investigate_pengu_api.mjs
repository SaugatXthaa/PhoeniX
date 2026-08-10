// Investigate pengu.uk API — find how to generate stream URLs
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// 1. Check pengu.uk main site
console.log('=== pengu.uk main page ===');
try {
  const r = await gotScraping.get('https://pengu.uk/', {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true, followRedirect: true,
  });
  console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body?.length || 0}`);
  console.log(`First 1000 chars:\n${r.body?.slice(0, 1000)}`);
} catch (e) { console.log(`ERR: ${e.message}`); }

// 2. Check common API paths
console.log('\n\n=== Check API endpoints ===');
const endpoints = [
  '/api',
  '/api/v1',
  '/api/sources',
  '/api/search',
  '/api/anime',
  '/api/stream',
  '/api/external',
  '/direct',
  '/direct/api',
  '/api/health',
  '/health',
  '/api/docs',
  '/docs',
];

for (const ep of endpoints) {
  try {
    const r = await gotScraping.head(`https://pengu.uk${ep}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    if (r.statusCode !== 404) {
      console.log(`${ep}: ${r.statusCode} | CT: ${r.headers['content-type']}`);
    }
  } catch (e) { /* skip */ }
}

// 3. The URL structure suggests the encrypted token encodes the anime ID + episode + language
// Let's check if there's a public API that returns these tokens
console.log('\n\n=== Check if pengu.uk has an addon manifest ===');
try {
  const r = await gotScraping.get('https://pengu.uk/manifest.json', {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`manifest.json: ${r.statusCode} | Body: ${r.body?.slice(0, 500)}`);
} catch (e) { console.log(`ERR: ${e.message}`); }

// 4. Check if it's a Stremio addon
console.log('\n=== Check /stream/ endpoint (Stremio addon pattern) ===');
try {
  const r = await gotScraping.get('https://pengu.uk/stream/movie/tt0468569.json', {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`/stream/movie/tt0468569.json: ${r.statusCode} | Body: ${r.body?.slice(0, 500)}`);
} catch (e) { console.log(`ERR: ${e.message}`); }

// 5. Check if it's a custom addon with different path
console.log('\n=== Check common Stremio addon paths ===');
for (const path of ['/manifest.json', '/stremio/manifest.json', '/addon/manifest.json', '/api/manifest']) {
  try {
    const r = await gotScraping.get(`https://pengu.uk${path}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true,
    });
    if (r.statusCode !== 404) {
      console.log(`${path}: ${r.statusCode} | Body: ${r.body?.slice(0, 300)}`);
    }
  } catch { /* skip */ }
}
