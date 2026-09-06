import { gotScraping } from 'got-scraping';

const fileId = '73580730';

// Common file host API patterns
const paths = [
  `/api/file/${fileId}`,
  `/api/source/${fileId}`,
  `/api/stream/${fileId}`,
  `/api/get/${fileId}`,
  `/api/v1/file/${fileId}`,
  `/api/v1/stream/${fileId}`,
  `/get/${fileId}`,
  `/stream/${fileId}`,
  `/file/${fileId}`,
  `/dl/${fileId}`,
  `/api/source?file_id=${fileId}`,
  `/api/file?id=${fileId}`,
];

for (const p of paths) {
  const url = `https://hanerix.com${p}`;
  const r = await gotScraping(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://hanerix.com/e/idai5wak9cv0' },
    timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: false,
  });
  if (r.statusCode !== 404 && r.statusCode !== 301 && r.statusCode !== 302) {
    console.log(`${p} → ${r.statusCode} (${r.body.length}b)`);
    if (r.body.length < 1000) console.log('  ', r.body.slice(0, 300));
  }
}

// Also check if there's a /api/ root
console.log('\n=== /api/ root ===');
const r = await gotScraping('https://hanerix.com/api/', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| body:', r.body.slice(0, 300));
