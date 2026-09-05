import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://new3.moviesdrive.christmas/your-name-2016/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Look for ANY links
const allLinks = [...r.body.matchAll(/href="([^"]+)"/g)];
console.log('Total links:', allLinks.length);

// Look for hubcloud links specifically
const hubLinks = allLinks.filter(m => m[1].includes('hubcloud'));
console.log('hubcloud links:', hubLinks.length);

// Look for any download-related links
const dlLinks = allLinks.filter(m => /download|drive|gdtot|gdflix|hubcloud|fastdl/i.test(m[1]));
console.log('Download links:', dlLinks.length);
for (const m of dlLinks.slice(0, 10)) {
  console.log('  ', m[1].slice(0, 150));
}

// Also look for buttons or onclick handlers
const buttons = [...r.body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)];
console.log('\nButtons:', buttons.length);

// Look for data-attributes
const dataAttrs = [...r.body.matchAll(/data-(?:url|link|href|download)="([^"]+)"/gi)];
console.log('data-url/link attrs:', dataAttrs.length);
for (const m of dataAttrs.slice(0, 5)) console.log('  ', m[1].slice(0, 150));
