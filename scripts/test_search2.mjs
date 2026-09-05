import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

// The from_ac in the URL IS the token (no need to extract FROM_AC_TOKEN)
const token = 'v7mp35yF2sGDVuoiar_OOjH3DAuaCs';
const pageUrl = `https://hubcloud.cx/drive/search-recover.php?from_ac=${token}`;

// Search for Naruto 1080p
const searchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Naruto%201080p&page=1&from_ac=${token}`;
console.log('Search URL:', searchUrl);
const searchRes = await gotScraping(searchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': pageUrl },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', searchRes.statusCode);
console.log('Body (first 1500):', searchRes.body.slice(0, 1500));
