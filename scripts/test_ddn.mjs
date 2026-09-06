import { gotScraping } from 'got-scraping';

// The JS had: https://ddn.iqsmartgames.com/file/
// Let me test if we can get a direct URL from ddn.iqsmartgames.com/file/<slug>
const slug = 'r8bp4ny';
const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';

console.log('=== ddn.iqsmartgames.com/file/' + slug + ' ===');
let r = await gotScraping(`https://ddn.iqsmartgames.com/file/${slug}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('Status:', r.statusCode, '| location:', r.headers.location);
if (r.body) console.log('Body:', r.body.slice(0, 500));

console.log('\n=== ddn.iqsmartgames.com/file/' + slug + '?key=' + key + ' ===');
r = await gotScraping(`https://ddn.iqsmartgames.com/file/${slug}?key=${key}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
if (r.body.length < 2000) console.log('Body:', r.body.slice(0, 1000));

// Also try /d/<slug> and /dl/<slug>
console.log('\n=== /d/' + slug + ' ===');
r = await gotScraping(`https://ddn.iqsmartgames.com/d/${slug}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('Status:', r.statusCode, '| location:', r.headers.location);
