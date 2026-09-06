import { gotScraping } from 'got-scraping';

const tests = [
  { host: 'hanerix.com', fileId: '73580730', referer: 'https://hanerix.com/e/idai5wak9cv0' },
  { host: 'smoothpre.com', fileId: '42400731', referer: 'https://smoothpre.com/v/v51t5m9qymh5' },
];

for (const t of tests) {
  console.log(`\n=== ${t.host} (file_id: ${t.fileId}) ===`);
  
  // Try POST /api/source/{file_id}
  const paths = [
    { method: 'POST', path: `/api/source/${t.fileId}` },
    { method: 'GET', path: `/api/source/${t.fileId}` },
    { method: 'POST', path: `/api/source/${t.fileId}`, body: 'api_source=1' },
    { method: 'POST', path: `/api/v1/source/${t.fileId}` },
    { method: 'GET', path: `/api/v1/source/${t.fileId}` },
  ];
  
  for (const p of paths) {
    const url = `https://${t.host}${p.path}`;
    const r = await gotScraping(url, {
      method: p.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/131',
        'Accept': 'application/json',
        'Referer': t.referer,
        'X-Requested-With': 'XMLHttpRequest',
        ...(p.body && { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      ...(p.body && { body: p.body }),
      timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: false,
    });
    if (r.statusCode !== 404) {
      console.log(`  ${p.method} ${p.path} → ${r.statusCode} (${r.body.length}b)`);
      if (r.body.length > 0 && r.body.length < 1000) console.log('    ', r.body.slice(0, 300));
    }
  }
}
