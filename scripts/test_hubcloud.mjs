// Test hubcloud search with got-scraping
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

const token = 'Hz9dUeKUmOjpn18JzYqVy4Fpx-tnwW';
const searchUrl = 'https://hubcloud.cx/drive/search-recover.php?api=search&q=Inception%20480p&page=1&from_ac=' + token;
console.log('Trying with got-scraping...');
const r = await gotScraping(searchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
console.log('Body (first 2000):', r.body.slice(0, 2000));
