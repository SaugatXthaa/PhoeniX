import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const fileId = '7zyzv5kaazyvhsd';
const token = '8W0C7p_M8CnyjGAaktlqJDkbMvk4qkcz_JKxRvUDSNsigBjyNwpM';

// Test 1: /drive/<id> with from_ac as query param
const url1 = `https://hubcloud.cx/drive/${fileId}?from_ac=${token}`;
console.log('Test 1:', url1.slice(0, 100));
let r = await gotScraping(url1, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| size:', r.body.length);

// Test 2: Maybe the URL format is /file/<id> now?
const url2 = `https://hubcloud.cx/file/${fileId}`;
console.log('Test 2:', url2);
r = await gotScraping(url2, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode);

// Test 3: /d/<id>
const url3 = `https://hubcloud.cx/d/${fileId}`;
console.log('Test 3:', url3);
r = await gotScraping(url3, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode);

// Test 4: Maybe we need to use a different domain?
const url4 = `https://hubcloud.foo/drive/${fileId}`;
console.log('Test 4:', url4);
r = await gotScraping(url4, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| location:', r.headers.location);

// Test 5: Try with the OLD from_ac format (the URL's from_ac, not extracted)
const oldToken = '8W0C7p_M8CnyjGAaktlqJDkbMvk4qk';
const url5 = `https://hubcloud.cx/drive/${fileId}?from_ac=${oldToken}`;
console.log('Test 5:', url5.slice(0, 100));
r = await gotScraping(url5, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| size:', r.body.length);
if (r.statusCode === 200) console.log('  Body sample:', r.body.slice(0, 300));
