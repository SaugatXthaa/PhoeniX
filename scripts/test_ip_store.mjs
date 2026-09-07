import { gotScraping } from 'got-scraping';

// Download and analyze the useStore.js file
const r = await gotScraping('https://www.imdbplay.tech/assets/useStore-r0Kk5vzo.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Look for API base URL
const apiUrls = [...js.matchAll(/(?:apiUrl|baseUrl|API_URL|BASE_URL|backend|server|host)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)];
console.log('API URLs:');
for (const m of apiUrls) console.log('  ', m[1]);

// Look for fetch/axios calls
const fetches = [...js.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/gi)];
console.log('\nFetch URLs:');
for (const m of fetches) console.log('  ', m[1]);

// Look for all URL patterns
const urls = [...js.matchAll(/["'`](https?:\/\/[^"'`]{5,100})["'`]/gi)];
console.log('\nAll URLs:');
for (const m of [...new Set(urls.map(m => m[1]))]) {
  if (!m.includes('google') && !m.includes('font') && !m.includes('cloudflare') && !m.includes('react')) {
    console.log('  ', m);
  }
}

// Look for stream/source/video patterns
const streams = [...js.matchAll(/["'`]([^"'`]*(?:stream|source|video|player|embed|watch|server|quality)[^"'`]*)["'`]/gi)];
console.log('\nStream/source patterns:');
for (const m of [...new Set(streams.map(m => m[1]))].slice(0, 20)) {
  if (m.length > 3 && m.length < 100) console.log('  ', m);
}

// Look for function definitions that might build stream URLs
const fns = [...js.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{[^}]{0,500}/g)];
console.log('\nFunctions (first 10):');
for (const m of fns.slice(0, 10)) {
  const name = m[1];
  const body = m[0].slice(0, 200);
  if (/stream|source|video|player|embed|url|fetch|api/i.test(body)) {
    console.log(`  ${name}: ${body.slice(0, 150)}`);
  }
}
