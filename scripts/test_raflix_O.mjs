import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://raflixx.vercel.app/assets/index-1tmTi0g4.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find O function — it's likely a wrapper around fetch that adds headers/params
// Search for "O=" or "const O=" or "function O"
const patterns = [
  /(?:const|var|let)\s+O\s*=\s*(?:async\s*)?\(?[^)]*\)?\s*=>\s*\{?[^}]{0,500}/,
  /function\s+O\s*\([^)]*\)\s*\{[^}]{0,500}/,
];

for (const p of patterns) {
  const m = js.match(p);
  if (m) {
    console.log('O function found:', m[0].slice(0, 500));
    break;
  }
}

// Also search for where "section" is added to URL or headers
const sectionAdd = [...js.matchAll(/section[^;]{0,100}(?:url|header|param|query|fetch|search|append|set)[^;]{0,100}/gi)];
console.log('\nSection + URL/header patterns:');
for (const m of [...new Set(sectionAdd.map(m => m[0]))].slice(0, 10)) {
  console.log('  ', m.slice(0, 200));
}

// Search for where the "section" query param is added
const sectionParam = [...js.matchAll(/section[=:][^;,}]{0,100}/gi)];
console.log('\nSection assignments:');
for (const m of [...new Set(sectionParam.map(m => m[0]))].slice(0, 15)) {
  if (m.length > 10 && !m.includes('IntersectionObserver') && !m.includes('sectionObserver')) {
    console.log('  ', m.slice(0, 150));
  }
}

// Look for URLSearchParams or searchParams usage
const searchParams = [...js.matchAll(/(?:searchParams|URLSearchParams|append|toString)\([^)]{0,100}\)/g)];
console.log('\nURLSearchParams usage:');
for (const m of [...new Set(searchParams.map(m => m[0]))].slice(0, 10)) {
  console.log('  ', m.slice(0, 150));
}

// The "section" might be added by the server-side API handler based on the media type
// Let me just try passing it as a header
console.log('\n=== Try with X-Section header ===');
for (const section of ['movie', 'tv', 'anime', 'browser', 'all']) {
  const r2 = await gotScraping(`https://raflixx.vercel.app/api/available-watch-providers/tmdb_movie_27205?region=US`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'X-Section': section, 'Section': section },
    timeout: { request: 5000 }, throwHttpErrors: false,
  });
  const data = JSON.parse(r2.body);
  if (data.providers?.length > 0) {
    console.log(`  X-Section: ${section} → ${data.providers.length} providers!`);
    for (const p of data.providers.slice(0, 3)) console.log('    ', JSON.stringify(p).slice(0, 200));
    break;
  } else {
    console.log(`  X-Section: ${section} → ${data.error || 'no providers'}`);
  }
}

// Try section as a cookie
console.log('\n=== Try with section cookie ===');
const r3 = await gotScraping(`https://raflixx.vercel.app/api/available-watch-providers/tmdb_movie_27205?region=US`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Cookie': 'section=movie' },
  timeout: { request: 5000 }, throwHttpErrors: false,
});
console.log('  Cookie section=movie:', JSON.parse(r3.body).error || JSON.parse(r3.body).providers?.length + ' providers');
