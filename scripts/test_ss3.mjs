import { gotScraping } from 'got-scraping';
const r = await gotScraping('https://screenscape.me/embed?imdb=tt32820897&type=movie&lan=hindi', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://multimovies.beer/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
// Look for stream URLs
const m3u8 = r.body.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi);
const mp4 = r.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
console.log('m3u8 URLs:', m3u8?.length || 0);
if (m3u8) for (const u of m3u8.slice(0, 3)) console.log('  ', u.slice(0, 150));
console.log('mp4 URLs:', mp4?.length || 0);
if (mp4) for (const u of mp4.slice(0, 3)) console.log('  ', u.slice(0, 150));
// Look for API calls
const apiCalls = r.body.match(/\/api\/[a-z0-9/_?=&-]+/gi);
console.log('API calls:', apiCalls?.length || 0);
if (apiCalls) for (const u of [...new Set(apiCalls)].slice(0, 5)) console.log('  ', u);
// Look for source/file patterns
const sources = r.body.match(/sources?\s*[:=]\s*\[[^\]]{1,500}/gi);
if (sources) for (const s of sources.slice(0, 2)) console.log('  sources:', s.slice(0, 200));
