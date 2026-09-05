import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const token = '8W0C7p_M8CnyjGAaktlqJDkbMvk4qkcz_JKxRvUDSNsigBjyNwpM';
const searchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Naruto%20S01E01%201080p&page=1&from_ac=${token}`;
const r = await gotScraping(searchUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://hubcloud.cx/drive/search-recover.php?from_ac=${token}` },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
const data = JSON.parse(r.body);
console.log('Hits:', data.hits?.length || 0);
console.log('Full first hit:', JSON.stringify(data.hits?.[0], null, 2));
console.log('\nAll hits URLs:');
for (const h of data.hits || []) {
  console.log('  ', h.url);
  console.log('  ', h.file_name?.slice(0, 80));
}
