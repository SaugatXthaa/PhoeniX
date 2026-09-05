import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

// Try fetching /drive/<id> with various referers
const fileId = '51nigyoyggyyns2';
const url = `https://hubcloud.cx/drive/${fileId}`;

console.log('Test 1: No Referer');
let r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| body first 200:', r.body.slice(0, 200));

console.log('Test 2: Referer = hubcloud.cx');
r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| body first 200:', r.body.slice(0, 200));

console.log('Test 3: With from_ac token in query');
r = await gotScraping(`${url}?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCs`, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| body first 500:', r.body.slice(0, 500));
