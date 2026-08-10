// Investigate AniWatch API — likely the backend for PenguPlay's "antova" source
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import fs from 'fs';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const BASE = 'https://aniwatch.dk';

// 1. Get the main page
console.log('=== AniWatch main page ===');
let r = await gotScraping.get(`${BASE}/`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true, followRedirect: true,
});
console.log(`Status: ${r.statusCode} | Final URL: ${r.url} | Body len: ${r.body.length}`);
fs.writeFileSync('/tmp/aniwatch_main.html', r.body);

// Search for API endpoints, source names, etc.
const apiMatches = [...r.body.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)];
console.log(`\nAPI paths found: ${apiMatches.length}`);
for (const m of [...new Set(apiMatches.map(x => x[1]))].slice(0, 20)) console.log(`  ${m}`);

// Search for "antova" or "dub" or "sub" or language-related strings
const langMatches = [...r.body.matchAll(/["'`](sub|dub|japanese|english|spanish|lang|audio)["'`]/gi)];
console.log(`\nLanguage mentions: ${langMatches.length}`);

// 2. Check common AniWatch API endpoints
console.log('\n=== Check AniWatch API endpoints ===');
const endpoints = [
  '/api/source',
  '/api/sources',
  '/api/search',
  '/api/anime',
  '/api/episodes',
  '/api/stream',
  '/api/v1',
  '/ajax/source',
  '/ajax/episodes',
  '/ajax/stream',
  '/ajax/server',
];
for (const ep of endpoints) {
  try {
    const r = await gotScraping.get(`${BASE}${ep}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true,
    });
    if (r.statusCode !== 404) {
      console.log(`${ep}: ${r.statusCode} | CT: ${r.headers['content-type']} | ${r.body?.slice(0, 200)}`);
    }
  } catch { /* skip */ }
}

// 3. Search for "Jujutsu Kaisen" to find the anime detail page structure
console.log('\n=== Search for Jujutsu Kaisen ===');
r = await gotScraping.get(`${BASE}/search?keyword=Jujutsu+Kaisen`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
});
console.log(`Search: ${r.statusCode} | Body len: ${r.body.length}`);
// Find anime links
const animeLinks = [...r.body.matchAll(/href=["'](\/(?:watch|anime|title)[^"']+)["']/g)];
console.log(`Anime links found: ${animeLinks.length}`);
for (const m of animeLinks.slice(0, 5)) console.log(`  ${m[1]}`);
