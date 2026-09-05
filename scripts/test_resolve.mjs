import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

// Test resolveFileUrl - fetch /drive/<fileId>
const fileId = 'lqfnupqndwajjlk';
const fileUrl = `https://hubcloud.cx/drive/${fileId}`;
console.log('1. Fetching file page:', fileUrl);
const r = await gotScraping(fileUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('  Status:', r.statusCode, '| size:', r.body.length);

// Look for pixeldrain URL
const pdMatch = r.body.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/i);
console.log('  pixeldrain URL:', pdMatch ? pdMatch[0] : 'NONE');

// Look for gamerxyt URL
const varUrlMatch = r.body.match(/var\s+url\s*=\s*'([^']+)'/);
const aHrefMatch = r.body.match(/href="(https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"]+)"/i);
const gamerUrl = varUrlMatch?.[1] || aHrefMatch?.[1];
console.log('  gamerxyt URL:', gamerUrl || 'NONE');

// Look for gpdl URL
const gpdlMatch = r.body.match(/https:\/\/gpdl\.hubcloud\.cx\/\?id=[A-Za-z0-9:]+/i);
console.log('  gpdl URL:', gpdlMatch ? gpdlMatch[0] : 'NONE');

// If we have gamerxyt URL, fetch it
if (gamerUrl) {
  console.log('\n2. Fetching gamerxyt bridge...');
  const g = await gotScraping(gamerUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  console.log('  Status:', g.statusCode, '| size:', g.body.length);
  
  // Look for worker URL
  const workerMatch = g.body.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/[A-Za-z0-9:_/-]+\/\d+\/[^"'\s<>]+/i);
  console.log('  worker URL:', workerMatch ? workerMatch[0].slice(0, 150) : 'NONE');
  
  // Look for pixel.hubcloud.cx URL
  const pixelMatch = g.body.match(/https:\/\/pixel\.hubcloud\.cx\/\?id=[A-Za-z0-9:_-]+/i);
  console.log('  pixel URL:', pixelMatch ? pixelMatch[0] : 'NONE');
  
  // Look for pixeldrain on gamerxyt page
  const pdMatch2 = g.body.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/i);
  console.log('  pixeldrain (gamerxyt):', pdMatch2 ? pdMatch2[0] : 'NONE');
  
  // Look for gpdl on gamerxyt page
  const gpdlMatch2 = g.body.match(/https:\/\/gpdl\.hubcloud\.cx\/\?id=[A-Za-z0-9:]+/i);
  console.log('  gpdl (gamerxyt):', gpdlMatch2 ? gpdlMatch2[0] : 'NONE');
  
  // Dump some of the page for inspection
  console.log('\n  Gamerxyt page sample (1500 chars):');
  console.log(g.body.slice(0, 1500));
}
