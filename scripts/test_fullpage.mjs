import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const url = 'https://hubcloud.cx/drive/search-recover.php?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCs';
const r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});

// Find script tags
const scriptMatches = [...r.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
console.log('Script tags:', scriptMatches.length);
for (let i = 0; i < scriptMatches.length; i++) {
  const content = scriptMatches[i][1];
  if (content.length > 0 && content.length < 5000) {
    console.log(`\n=== Script ${i} (${content.length} chars) ===`);
    console.log(content);
  }
}

// Also look for fetch/XMLHttpRequest patterns
console.log('\n=== API patterns ===');
const apiPatterns = [
  /api=search[^"'\s]*/gi,
  /from_ac=[A-Za-z0-9_-]+/gi,
  /fetch\([^)]+\)/gi,
  /XMLHttpRequest/gi,
];
for (const p of apiPatterns) {
  const matches = [...r.body.matchAll(p)];
  for (const m of matches.slice(0, 3)) {
    console.log('  ', m[0].slice(0, 150));
  }
}
