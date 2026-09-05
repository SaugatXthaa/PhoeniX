import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const fileId = '7zyzv5kaazyvhsd';
const token = '8W0C7p_M8CnyjGAaktlqJDkbMvk4qkcz_JKxRvUDSNsigBjyNwpM';

// Test 1: API endpoint for file details
const url1 = `https://hubcloud.cx/drive/search-recover.php?api=file&id=${fileId}&from_ac=${token}`;
console.log('Test 1 (api=file):', url1.slice(0, 100));
let r = await gotScraping(url1, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://hubcloud.cx/drive/search-recover.php?from_ac=${token}` },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('  Status:', r.statusCode, '| body:', r.body.slice(0, 500));

// Test 2: Maybe the URL needs to be /drive/<id>/download or /drive/<id>/stream
const url2 = `https://hubcloud.cx/drive/${fileId}/download`;
console.log('\nTest 2 (/drive/<id>/download):', url2);
r = await gotScraping(url2, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| location:', r.headers.location);

// Test 3: Try hubcloud.cx/dl/<id>
const url3 = `https://hubcloud.cx/dl/${fileId}`;
console.log('\nTest 3 (/dl/<id>):', url3);
r = await gotScraping(url3, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('  Status:', r.statusCode, '| location:', r.headers.location);

// Test 4: Try the search-recover page with the file ID as query
const url4 = `https://hubcloud.cx/drive/search-recover.php?api=download&id=${fileId}&from_ac=${token}`;
console.log('\nTest 4 (api=download):', url4.slice(0, 100));
r = await gotScraping(url4, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://hubcloud.cx/drive/search-recover.php?from_ac=${token}` },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('  Status:', r.statusCode, '| body:', r.body.slice(0, 500));
