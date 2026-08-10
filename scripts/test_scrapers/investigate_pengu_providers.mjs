// Check PenguPlay's provider list and API structure
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import fs from 'fs';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// 1. Get the full main page HTML to find provider info
console.log('=== pengu.uk main page (full HTML) ===');
const r = await gotScraping.get('https://pengu.uk/', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
fs.writeFileSync('/tmp/pengu_main.html', r.body);
console.log(`Saved ${r.body.length} bytes`);

// Search for provider names, API endpoints, etc.
const patterns = [
  /provider[s]?["\s:=]+["']([^"']+)["']/gi,
  /source[s]?["\s:=]+["']([^"']+)["']/gi,
  /api[/\w]*/g,
  /fetch\s*\([^)]+\)/g,
  /https?:\/\/[a-z0-9.\-]+\.[a-z]{2,}[/\w.-]*/gi,
];

const found = new Set();
for (const p of patterns) {
  const m = r.body.match(p);
  if (m) m.slice(0, 30).forEach(x => found.add(x));
}
console.log(`\nFound ${found.size} candidate strings:`);
for (const f of [...found].slice(0, 80)) console.log(`  ${f}`);

// 2. Check the JS bundles
console.log('\n=== Find JS bundles ===');
const jsMatches = [...r.body.matchAll(/src=["']([^"']+\.js[^"']*)["']/g)];
for (const m of jsMatches.slice(0, 10)) {
  console.log(`  JS: ${m[1]}`);
}

// 3. Check for /configure or /settings pages
console.log('\n=== Check configure/settings pages ===');
for (const path of ['/configure', '/settings', '/providers', '/sources', '/signin', '/login']) {
  try {
    const r = await gotScraping.get(`https://pengu.uk${path}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: false,
    });
    console.log(`${path}: ${r.statusCode} | Location: ${r.headers.location || 'none'}`);
  } catch { /* skip */ }
}
