import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Look for fetch calls with URLs
const fetches = [...js.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/gi)];
console.log('Fetch URLs:');
for (const m of [...new Set(fetches.map(m => m[1]))]) console.log('  ', m);

// Look for template literals with fetch
const templateFetches = [...js.matchAll(/fetch\(`([^`]+)`/gi)];
console.log('\nTemplate fetch URLs:');
for (const m of [...new Set(templateFetches.map(m => m[1]))]) console.log('  ', m);

// Look for all non-standard URLs
const urls = [...js.matchAll(/["'`](https?:\/\/[^"'`]{5,150})["'`]/gi)];
console.log('\nAll URLs (non-standard):');
for (const m of [...new Set(urls.map(m => m[1]))]) {
  if (!m.includes('google') && !m.includes('font') && !m.includes('cloudflare') && 
      !m.includes('react') && !m.includes('github') && !m.includes('w3.org') &&
      !m.includes('schema') && !m.includes('mozilla') && !m.includes('microsoft') &&
      !m.includes('x.com') && !m.includes('image.tmdb')) {
    console.log('  ', m);
  }
}

// Look for API base / backend URL
const apiBases = [...js.matchAll(/["'`](https?:\/\/[^"'`]*(?:api|backend|server|cdn|stream|video|player)[^"'`]*)["'`]/gi)];
console.log('\nAPI/backend URLs:');
for (const m of [...new Set(apiBases.map(m => m[1]))]) console.log('  ', m);

// Look for the TMDB API key
const tmdbKeys = [...js.matchAll(/api_key=([a-f0-9]{32})/gi)];
console.log('\nTMDB API keys:');
for (const m of [...new Set(tmdbKeys.map(m => m[1]))]) console.log('  ', m);

// Look for stream/server/source function definitions
const streamFns = [...js.matchAll(/(?:async\s+)?function\s+(\w*(?:stream|source|video|player|embed|server|watch|play)\w*)\s*\(/gi)];
console.log('\nStream-related functions:');
for (const m of streamFns) console.log('  ', m[1]);

// Look for the actual stream URL builder — search for "m3u8" or "mp4" or "hls"
const mediaUrls = [...js.matchAll(/["'`]([^"'`]*(?:\.m3u8|\.mp4|\.mkv|hls|dash)[^"'`]*)["'`]/gi)];
console.log('\nMedia URL patterns:');
for (const m of [...new Set(mediaUrls.map(m => m[1]))]) console.log('  ', m);
