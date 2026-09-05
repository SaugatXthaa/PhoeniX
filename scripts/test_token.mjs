import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

// Visit the hubcloud.cx page (the from_ac URL)
const url = 'https://hubcloud.cx/drive/search-recover.php?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCs';
console.log('Visiting:', url);
const r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
console.log('Body length:', r.body.length);

// Look for FROM_AC_TOKEN
const tokenMatch = r.body.match(/FROM_AC_TOKEN\s*=\s*"([^"]+)"/);
console.log('FROM_AC_TOKEN:', tokenMatch?.[1]?.slice(0, 50));

// Look for any other token patterns
const tokenPatterns = [
  /from_ac['"\s:=]+['"]([A-Za-z0-9_-]{20,})['"]/gi,
  /token['"\s:=]+['"]([A-Za-z0-9_-]{20,})['"]/gi,
  /api[_-]?token['"\s:=]+['"]([A-Za-z0-9_-]{20,})['"]/gi,
];
for (const p of tokenPatterns) {
  const matches = [...r.body.matchAll(p)];
  if (matches.length > 0) {
    console.log('Found token pattern:', p.source.slice(0, 30));
    for (const m of matches.slice(0, 3)) {
      console.log('  ', m[1]?.slice(0, 50));
    }
  }
}

// Show page sample
console.log('\nPage sample (first 1500 chars):');
console.log(r.body.slice(0, 1500));
