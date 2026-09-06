import { gotScraping } from 'got-scraping';
import fs from 'fs';

const r = await gotScraping('https://hanerix.com/assets/jquery/hg-p1.js?type=main&u=40&v=20260807213908', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://hanerix.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

fs.writeFileSync('/tmp/hgp1.js', r.body);

// Search for key patterns
const patterns = [
  /\/api\/[a-z0-9/_?=${}.&-]+/gi,
  /fetch\([^)]+\)/gi,
  /function\s+\w+\s*\([^)]*\)\s*\{/gi,
  /\.m3u8/gi,
  /\.mp4/gi,
  /file_id/gi,
  /getSources/gi,
  /sources\s*:/gi,
  /hls\./gi,
  /videojs/gi,
];

for (const p of patterns) {
  const matches = [...r.body.matchAll(p)];
  if (matches.length > 0) {
    console.log(`\n=== ${p.source} (${matches.length} matches) ===`);
    for (const m of [...new Set(matches.map(m => m[0]))].slice(0, 5)) {
      console.log('  ', m.slice(0, 200));
    }
  }
}

// Also look for /api/ or endpoint patterns
console.log('\n=== /api or /get or /stream patterns ===');
const endpointPatterns = r.body.match(/["'`/](?:api|get|stream|source|file|download|play)[a-z0-9_/${}?=&.-]{0,80}/gi);
if (endpointPatterns) {
  for (const e of [...new Set(endpointPatterns)].slice(0, 15)) console.log('  ', e);
}
