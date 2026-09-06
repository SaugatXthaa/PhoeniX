import { gotScraping } from 'got-scraping';

const slug = 'r8bp4ny';
const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';

// Test pro.iqsmartgames.com/evid/<slug>
console.log('=== /evid/' + slug + ' ===');
let r = await gotScraping(`https://pro.iqsmartgames.com/evid/${slug}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('Status:', r.statusCode, '| location:', r.headers.location, '| size:', r.body.length);
if (r.body) console.log('Body (first 500):', r.body.slice(0, 500));

// Try with key
console.log('\n=== /evid/' + slug + '?key=' + key + ' ===');
r = await gotScraping(`https://pro.iqsmartgames.com/evid/${slug}?key=${key}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
if (r.body) {
  // Look for m3u8/mp4
  const m3u8 = r.body.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi);
  const mp4 = r.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
  console.log('m3u8:', m3u8?.[0]?.slice(0, 150) || 'none');
  console.log('mp4:', mp4?.[0]?.slice(0, 150) || 'none');
  // Look for sources/file
  const sources = r.body.match(/sources?\s*[:=]\s*\[[^\]]{1,500}/gi);
  if (sources) console.log('sources:', sources[0].slice(0, 200));
  const file = r.body.match(/file\s*:\s*"[^"]*"/gi);
  if (file) console.log('file:', file[0]);
  // Show first 500 chars
  console.log('Body sample:', r.body.slice(0, 500));
}
