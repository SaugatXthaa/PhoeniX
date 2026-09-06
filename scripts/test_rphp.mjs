import { gotScraping } from 'got-scraping';

const url = 'https://hshare.ink/r.php?d=SW5jZXB0aW9uLigyMDEwKS4xMDgwcC5EdWFsLkF1ZGlvLihIaW4tRW5nKS5ta3Y&t=1788678548&s=fad1fa45ebaf5710';
const r = await gotScraping(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('Status:', r.statusCode);
console.log('Location:', r.headers.location);
console.log('Body length:', r.body.length);
console.log('Body (first 1000):', r.body.slice(0, 1000));

// If it has a redirect, follow it
if (r.headers.location) {
  console.log('\n=== Following redirect ===');
  const r2 = await gotScraping(r.headers.location, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://hshare.ink/' },
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  console.log('Status:', r2.statusCode, '| size:', r2.body.length);
  // Look for direct URLs
  const urls = [...r2.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
  console.log('URLs:');
  for (const u of [...new Set(urls.map(m => m[0]))].slice(0, 10)) {
    console.log('  ', u.slice(0, 200));
  }
}
