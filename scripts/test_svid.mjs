import { gotScraping } from 'got-scraping';

const slug = 'r8bp4ny';
const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';

// Follow /evid/<slug> redirect to /svid/<encoded>
console.log('=== Step 1: /evid/' + slug + ' (follow redirect) ===');
let r = await gotScraping(`https://pro.iqsmartgames.com/evid/${slug}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Final URL:', r.url);
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Look for stream URLs
const m3u8 = r.body.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi);
const mp4 = r.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
console.log('m3u8:', m3u8?.[0]?.slice(0, 200) || 'none');
console.log('mp4:', mp4?.[0]?.slice(0, 200) || 'none');

// Look for sources/file
const sources = r.body.match(/sources?\s*[:=]\s*\[[^\]]{1,800}/gi);
if (sources) console.log('sources:', sources[0].slice(0, 300));
const file = r.body.match(/file\s*:\s*"[^"]*"/gi);
if (file) console.log('file:', file[0]);

// Look for API calls
const apiCalls = r.body.match(/\/api\/[a-z0-9/_?=&.-]+/gi);
if (apiCalls) {
  console.log('API calls:', [...new Set(apiCalls)].slice(0, 5));
}

// Look for /svid/ or /download/ patterns
const svidUrls = r.body.match(/\/svid\/[a-zA-Z0-9_-]+/gi);
if (svidUrls) console.log('svid URLs:', [...new Set(svidUrls)]);
const dlUrls = r.body.match(/\/download\/[a-zA-Z0-9_-]+/gi);
if (dlUrls) console.log('download URLs:', [...new Set(dlUrls)]);

// Show body sample
console.log('\nBody sample (first 1000):');
console.log(r.body.slice(0, 1000));
