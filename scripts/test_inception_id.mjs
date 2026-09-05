import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

// Inception file ID that worked before
const inceptionId = 'lqfnupqndwajjlk';
const url1 = `https://hubcloud.cx/drive/${inceptionId}`;
console.log('Inception file ID:', url1);
let r = await gotScraping(url1, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('  Status:', r.statusCode, '| size:', r.body.length);

// Naruto file ID that fails
const narutoId = '7zyzv5kaazyvhsd';
const url2 = `https://hubcloud.cx/drive/${narutoId}`;
console.log('\nNaruto file ID:', url2);
r = await gotScraping(url2, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://hubcloud.cx/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('  Status:', r.statusCode, '| size:', r.body.length);

// Check if maybe Naruto files are on a different domain
// Let me search again and check the URL field
const token = '8W0C7p_M8CnyjGAaktlqJDkbMvk4qkcz_JKxRvUDSNsigBjyNwpM';
const searchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Naruto%20S01E01%201080p&page=1&from_ac=${token}`;
r = await gotScraping(searchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://hubcloud.cx/drive/search-recover.php?from_ac=${token}` },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const data = JSON.parse(r.body);
console.log('\nNaruto search hit URL:', data.hits?.[0]?.url);

// Try Inception search to see if URL format is different
const inceptionToken = 'qgmK83zoC1NsO65hixeLrKdxoUXisy';
const inceptionSearchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Inception%201080p&page=1&from_ac=${inceptionToken}`;
r = await gotScraping(inceptionSearchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://hubcloud.cx/drive/search-recover.php?from_ac=${inceptionToken}` },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const idata = JSON.parse(r.body);
console.log('\nInception search hit URL:', idata.hits?.[0]?.url);
