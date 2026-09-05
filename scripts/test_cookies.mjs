import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const url = 'https://hubcloud.cx/drive/search-recover.php?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCs';
const r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Set-Cookie:', r.headers['set-cookie']);
console.log('All headers:', JSON.stringify(r.headers, null, 2));
