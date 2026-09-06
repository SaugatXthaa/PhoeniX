import { gotScraping } from 'got-scraping';

const slug = 'r8bp4ny';

const r = await gotScraping(`https://pro.iqsmartgames.com/evid/${slug}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});

// Find getResponseData function
const fnMatch = r.body.match(/(?:async\s+)?function\s+getResponseData[\s\S]{0,3000}/);
if (fnMatch) {
  console.log('=== getResponseData function ===');
  console.log(fnMatch[0].slice(0, 2000));
}

// Also find getSources or loadFirstAvailableVideo
const loadMatch = r.body.match(/(?:async\s+)?function\s+loadFirstAvailableVideo[\s\S]{0,2000}/);
if (loadMatch) {
  console.log('\n=== loadFirstAvailableVideo function ===');
  console.log(loadMatch[0].slice(0, 1500));
}

// Find all external JS files
console.log('\n=== External JS files ===');
const jsFiles = [...r.body.matchAll(/src="([^"]*\.js[^"]*)"/g)];
for (const m of jsFiles) console.log('  ', m[1]);
