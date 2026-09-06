import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://pro.iqsmartgames.com/assets/piliyerxnew.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://pro.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Find getResponseData function
const fnMatch = r.body.match(/(?:async\s+)?function\s+getResponseData[\s\S]{0,5000}/);
if (fnMatch) {
  console.log('=== getResponseData function ===');
  console.log(fnMatch[0].slice(0, 3000));
}

// Find API calls
console.log('\n=== API/fetch patterns ===');
const fetches = r.body.match(/fetch\([^)]+\)/g);
if (fetches) for (const f of [...new Set(fetches)].slice(0, 10)) console.log('  ', f.slice(0, 200));

// Find URLs
console.log('\n=== URLs ===');
const urls = r.body.match(/https?:\/\/[a-z0-9.-]+\.[a-z]+\/[a-z0-9/_?=${}.&-]+/gi);
if (urls) for (const u of [...new Set(urls)].slice(0, 15)) console.log('  ', u.slice(0, 150));

// Find /api/ patterns
console.log('\n=== /api/ patterns ===');
const apis = r.body.match(/\/api\/[a-z0-9/_?=${}.&-]+/gi);
if (apis) for (const a of [...new Set(apis)].slice(0, 10)) console.log('  ', a);
