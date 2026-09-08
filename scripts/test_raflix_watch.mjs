import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://raflixx.vercel.app/watch/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Find ALL URLs in the watch page
const urls = [...r.body.matchAll(/https?:\/\/[^"'<>\s]+/gi)];
const unique = [...new Set(urls.map(m => m[0]))].filter(u => 
  !u.includes('google') && !u.includes('font') && !u.includes('cloudflare') && 
  !u.includes('jsdelivr') && !u.includes('unpkg') && !u.includes('w3.org') &&
  !u.includes('schema') && !u.includes('react') && !u.includes('github') &&
  !u.includes('vercel') && !u.includes('wsrv') && !u.includes('snapchat') &&
  !u.includes('instagram') && !u.includes('whatsapp') && !u.includes('youtube') &&
  !u.includes('tmdb') && !u.includes('microsoft')
);
console.log('\nExternal URLs:', unique.length);
for (const u of unique) console.log('  ', u.slice(0, 200));

// Look for stream/embed/iframe URLs
const streamUrls = [...r.body.matchAll(/https?:\/\/[^"'<>\s]*(?:stream|embed|video|player|source|watch|play|vid)[^"'<>\s]*/gi)];
console.log('\nStream URLs:');
for (const u of [...new Set(streamUrls.map(m => m[0]))]) console.log('  ', u.slice(0, 200));

// Look for __NEXT_DATA__ or similar
const nextData = r.body.match(/__NEXT_DATA__[^<]{0,500}/);
if (nextData) console.log('\nNEXT data:', nextData[0].slice(0, 300));

// Look for script type=application/json
const jsonScripts = [...r.body.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)];
console.log('\nJSON scripts:', jsonScripts.length);
for (const s of jsonScripts) {
  console.log('  ', s[1].slice(0, 500));
}

// Look for ALL iframes
const iframes = [...r.body.matchAll(/<iframe[^>]*>/gi)];
console.log('\nIframes:', iframes.length);
for (const m of iframes) {
  const src = m[0].match(/src="([^"]+)"/);
  console.log('  src:', src?.[1]?.slice(0, 200) || 'none');
}

// Dump the full page
console.log('\n=== Full page ===');
console.log(r.body.slice(0, 3000));
