import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const fileId = '7zyzv5kaazyvhsd';
const url = `https://hubcloud.cx/drive/${fileId}`;
console.log('Fetching:', url);
const r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Look for gamerxyt URL
const varUrlMatch = r.body.match(/var\s+url\s*=\s*'([^']+)'/);
const aHrefMatch = r.body.match(/href="(https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"]+)"/i);
const gamerUrl = varUrlMatch?.[1] || aHrefMatch?.[1];
console.log('gamerxyt URL:', gamerUrl || 'NONE');

if (gamerUrl) {
  console.log('\nFetching gamerxyt...');
  const g = await gotScraping(gamerUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  console.log('Status:', g.statusCode, '| size:', g.body.length);
  
  const pixelMatch = g.body.match(/https:\/\/pixel\.hubcloud\.cx\/\?id=[A-Za-z0-9:_-]+/i);
  console.log('pixel URL:', pixelMatch?.[0]?.slice(0, 100) || 'NONE');
  
  const workerMatch = g.body.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/[A-Za-z0-9:_/-]+\/\d+\/[^"'\s<>]+/i);
  console.log('worker URL:', workerMatch?.[0]?.slice(0, 100) || 'NONE');
}
