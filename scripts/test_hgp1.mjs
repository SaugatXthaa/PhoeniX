import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://hanerix.com/assets/jquery/hg-p1.js?type=main&u=40&v=20260807213908', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://hanerix.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Find API calls
const apis = r.body.match(/\/api\/[a-z0-9/_?=${}.&-]+/gi);
if (apis) {
  console.log('\nAPI calls:');
  for (const a of [...new Set(apis)]) console.log('  ', a);
}

// Find fetch calls
const fetches = r.body.match(/fetch\([^)]+\)/g);
if (fetches) {
  console.log('\nFetch calls:');
  for (const f of [...new Set(fetches)].slice(0, 10)) console.log('  ', f.slice(0, 200));
}

// Find getSources or similar
const fns = r.body.match(/function\s+(getSources|getResponseData|loadVideo|playVideo|initPlayer)[\s\S]{0,1000}/gi);
if (fns) {
  console.log('\nFunctions:');
  for (const f of fns) console.log('  ', f.slice(0, 500));
}

// Find m3u8/mp4 patterns
const m3u8 = r.body.match(/[^"'\s]{0,100}\.m3u8[^"'\s]{0,50}/gi);
if (m3u8) console.log('\nm3u8 patterns:', [...new Set(m3u8)].slice(0, 3));
const mp4 = r.body.match(/[^"'\s]{0,100}\.mp4[^"'\s]{0,50}/gi);
if (mp4) console.log('mp4 patterns:', [...new Set(mp4)].slice(0, 3));

// Find file_id or file_id patterns
const fileIdPatterns = r.body.match(/file_id[^,;]{1,100}/gi);
if (fileIdPatterns) console.log('\nfile_id patterns:', [...new Set(fileIdPatterns)].slice(0, 5));

// Find all URL patterns
const urls = r.body.match(/https?:\/\/[a-z0-9.-]+\.[a-z]+\/[a-z0-9/_?=${}.&-]+/gi);
if (urls) {
  console.log('\nURLs:');
  for (const u of [...new Set(urls)].slice(0, 10)) console.log('  ', u.slice(0, 150));
}
