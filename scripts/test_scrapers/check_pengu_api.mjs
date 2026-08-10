// Check PenguPlay API endpoints without auth
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Check auth config (public)
console.log('=== /api/auth/config ===');
let r = await gotScraping.get('https://pengu.uk/api/auth/config', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
console.log(`Status: ${r.statusCode} | Body: ${r.body?.slice(0, 500)}`);

// Check user config without auth
console.log('\n=== /api/user/config (no auth) ===');
r = await gotScraping.get('https://pengu.uk/api/user/config', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
console.log(`Status: ${r.statusCode} | Body: ${r.body?.slice(0, 500)}`);

// Try auth status
console.log('\n=== /auth/status (POST, empty token) ===');
r = await gotScraping.post('https://pengu.uk/auth/status', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Content-Type': 'application/json', 'Accept': 'application/json' },
  body: JSON.stringify({ token: '' }),
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
console.log(`Status: ${r.statusCode} | Body: ${r.body?.slice(0, 500)}`);

// Check if there's a public /api/providers or /api/sources endpoint
console.log('\n=== Check public API endpoints ===');
for (const path of ['/api/providers', '/api/sources', '/api/languages', '/api/defaults', '/api/config', '/api/stream/movie/tt0468569', '/api/stream/series/tmdb:95479:1:1']) {
  r = await gotScraping.get(`https://pengu.uk${path}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 8000 }, throwHttpErrors: false, http2: true,
  });
  if (r.statusCode !== 404) {
    console.log(`${path}: ${r.statusCode} | Body: ${r.body?.slice(0, 300)}`);
  }
}

// Check the /stream endpoint with different IDs to see error messages
console.log('\n=== /stream/series/tmdb:95479:1:1.json (no auth) ===');
r = await gotScraping.get('https://pengu.uk/stream/series/tmdb:95479:1:1.json', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
console.log(`Status: ${r.statusCode} | Body: ${r.body?.slice(0, 800)}`);
