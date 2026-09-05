import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const token = '6f33f7d03262464ea48798e2d2d0b0a7';
const pageUrl = 'https://hubcloud.cx/drive/search-recover.php?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCs';
const searchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Naruto%201080p&page=1&from_ac=${token}`;
console.log('Search URL:', searchUrl);
const r = await gotScraping(searchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': pageUrl },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
console.log('Body (first 2000):', r.body.slice(0, 2000));
