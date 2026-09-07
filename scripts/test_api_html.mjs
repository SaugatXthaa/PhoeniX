import { gotScraping } from 'got-scraping';

// Try fetching /api/ paths with HTML accept
const paths = [
  '/api/stream/movie/27205',
  '/api/sources/movie/27205', 
  '/api/play/movie/27205',
  '/api/video/movie/27205',
  '/api/server/movie/27205',
  '/api/embed/movie/27205',
];

for (const p of paths) {
  const r = await gotScraping(`https://www.imdbplay.tech${p}`, {
    headers: { 
      'User-Agent': 'Mozilla/5.0 Chrome/131',
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': 'https://www.imdbplay.tech/movie/27205',
    },
    timeout: { request: 8000 }, throwHttpErrors: false,
  });
  if (r.statusCode !== 404 && r.body.length > 0) {
    console.log(`${p} → ${r.statusCode} (${r.body.length}b)`);
    if (r.body.length < 500) console.log('  ', r.body.slice(0, 200));
    else {
      // Look for embed/stream URLs
      const urls = r.body.match(/https?:\/\/[^"'\s<>]+/gi);
      if (urls) {
        const unique = [...new Set(urls)].filter(u => !u.includes('google') && !u.includes('font') && !u.includes('cloudflare') && !u.includes('imdbplay.tech'));
        if (unique.length > 0) {
          console.log('  URLs:', unique.slice(0, 5));
        }
      }
      // Look for iframe
      const iframe = r.body.match(/<iframe[^>]*src="([^"]+)"/i);
      if (iframe) console.log('  Iframe:', iframe[1].slice(0, 200));
    }
  } else {
    console.log(`${p} → ${r.statusCode}`);
  }
}

// Also try POST with server function body
const postRes = await gotScraping.post('https://www.imdbplay.tech/movie/27205', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Accept': 'text/html',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://www.imdbplay.tech/movie/27205',
  },
  body: 'server=4&quality=4k',
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log(`\nPOST /movie/27205 → ${postRes.statusCode} (${postRes.body.length}b)`);
// Look for iframe/embed
const iframe = postRes.body.match(/<iframe[^>]*src="([^"]+)"/i);
if (iframe) console.log('  Iframe:', iframe[1].slice(0, 200));
