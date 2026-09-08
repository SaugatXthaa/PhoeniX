import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://raflixx.vercel.app/assets/index-1tmTi0g4.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find Ot function
const otMatch = js.match(/(?:function\s+Ot|Ot\s*=\s*|const\s+Ot\s*=\s*)(?:async\s*)?\(?[^)]*\)?\s*(?:=>\s*)?\{?[^}]{0,800}/);
if (otMatch) {
  console.log('Ot function:', otMatch[0].slice(0, 500));
}

// Also find where "section" is added to the URL
// The function tn() calls O() which calls Ot()
// Ot() probably adds "section" as a query param based on the current route
// Let me search for where "section" is appended to URLs
const sectionUrl = [...js.matchAll(/section[^;]{0,50}(?:url|fetch|search|param|append|set|query)[^;]{0,100}/gi)];
console.log('\nSection + URL patterns:');
for (const m of sectionUrl) console.log('  ', m[0].slice(0, 200));

// Look for where the section is derived from the media type
const sectionDerive = [...js.matchAll(/section\s*[=:]\s*(?:e\.type|r\.type|media\.type|type)[^;]{0,100}/gi)];
console.log('\nSection from type:');
for (const m of sectionDerive) console.log('  ', m[0].slice(0, 150));

// Maybe the section is part of the URL path itself
// Let me try different URL formats
console.log('\n=== Try different URL formats ===');
const tests = [
  '/api/available-watch-providers/tmdb_movie_27205?region=US&section=movie',
  '/api/available-watch-providers/tmdb_movie_27205?region=US&section=movie&genre=Action',
  '/api/available-watch-providers/tmdb_movie_27205?section=movie&region=US',
  '/api/available-watch-providers/tmdb_movie_27205?section=movie',
  '/api/available-watch-providers/movie/27205?section=movie',
  '/api/available-watch-providers/movie?section=movie',
  '/api/available-watch-providers?section=movie&id=tmdb_movie_27205',
  '/api/available-watch-providers?section=movie&id=27205&type=movie',
  '/api/available-watch-providers?section=movie&tmdbId=27205&type=movie&region=US',
];

for (const url of tests) {
  const r2 = await gotScraping(`https://raflixx.vercel.app${url}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
    timeout: { request: 5000 }, throwHttpErrors: false,
  });
  const body = r2.body.slice(0, 200);
  if (r2.statusCode !== 404 && !body.includes('Valid section required')) {
    console.log(`  ✓ ${url} → ${r2.statusCode}: ${body}`);
  } else if (r2.statusCode === 200) {
    const data = JSON.parse(r2.body);
    if (data.providers?.length > 0) {
      console.log(`  ✓✓ ${url} → ${data.providers.length} providers!`);
      break;
    }
  }
}
