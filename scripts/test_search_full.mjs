import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const fullToken = 'v7mp35yF2sGDVuoiar_OOjH3DAuaCsbvpBzl7eRNeQbMTj1XfMdJ';
const pageUrl = `https://hubcloud.cx/drive/search-recover.php?from_ac=${fullToken}`;
const searchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Naruto%201080p&page=1&from_ac=${fullToken}`;
console.log('Search URL:', searchUrl);
const r = await gotScraping(searchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': pageUrl },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
console.log('Body (first 2000):', r.body.slice(0, 2000));
