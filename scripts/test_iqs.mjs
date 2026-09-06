import { gotScraping } from 'got-scraping';

const id = 'tt32820897';
const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';

// Try different API paths
const paths = [
  `/api/2/movie?id=${id}`,
  `/api/2/movie?id=${id}&key=${key}`,
  `/api/movie?id=${id}&key=${key}`,
  `/api/source?id=${id}&key=${key}`,
  `/api/v1/movie?id=${id}&key=${key}`,
  `/api/2/movie/${id}?key=${key}`,
];

for (const p of paths) {
  const url = `https://streams.iqsmartgames.com${p}`;
  console.log(`Testing: ${url.slice(0, 100)}`);
  const r = await gotScraping(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Chrome/131',
      'Accept': 'application/json',
      'Referer': 'https://streams.iqsmartgames.com/embed/movie/' + id,
      'Origin': 'https://streams.iqsmartgames.com',
    },
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  console.log(`  Status: ${r.statusCode} | size: ${r.body.length}`);
  if (r.statusCode === 200 && r.body.length > 0 && r.body.length < 5000) {
    console.log(`  Body: ${r.body.slice(0, 500)}`);
  }
  console.log('');
}

// Also look at the embed page JS more carefully
console.log('=== Embed page JS ===');
const embedRes = await gotScraping(`https://streams.iqsmartgames.com/embed/movie/${id}?key=${key}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://multimovies.beer/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
// Find all JS variables
const vars = embedRes.body.match(/let\s+\w+\s*=\s*[^;]+;/g);
if (vars) for (const v of vars) console.log('  ', v.slice(0, 150));
// Find fetch calls
const fetches = embedRes.body.match(/fetch\([^)]+\)/g);
if (fetches) for (const f of fetches) console.log('  fetch:', f.slice(0, 150));
