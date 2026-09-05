import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

// Get a fresh token first
const tokenUrl = 'https://hubcloud.cx/drive/search-recover.php?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCs';
const tokenRes = await gotScraping(tokenUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const tokenMatch = tokenRes.body.match(/FROM_AC_TOKEN\s*=\s*"([^"]+)"/);
const realToken = tokenMatch?.[1];
console.log('Real token:', realToken?.slice(0, 40), '...');

// Search for Naruto 1080p
const searchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Naruto%201080p&page=1&from_ac=${realToken}`;
const searchRes = await gotScraping(searchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': tokenUrl },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Search status:', searchRes.statusCode);
const data = JSON.parse(searchRes.body);
console.log('Hits:', data.hits?.length || 0);
for (const h of (data.hits || []).slice(0, 5)) {
  console.log('  file_name:', h.file_name?.slice(0, 80));
  console.log('  url:', h.url);
  console.log('  size:', h.size);
  console.log('---');
}
