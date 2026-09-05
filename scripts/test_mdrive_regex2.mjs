import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://mdrive.lol/archive/13475/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const decoded = r.body.replace(/&amp;/g, '&');

// Test with larger limit
const urlRe = /href="(https:\/\/hubcloud\.cx\/drive\/[A-Za-z0-9_]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi;
let um;
while ((um = urlRe.exec(decoded)) !== null) {
  console.log('URL:', um[1]);
  console.log('  innerHTML:', um[2].slice(0, 200));
  console.log('  text:', um[2].replace(/<[^>]+>/g, '').trim().slice(0, 80));
  console.log('');
}

// Also test: simpler regex that just finds the URL without requiring </a>
const simpleRe = /href="(https:\/\/hubcloud\.cx\/drive\/[A-Za-z0-9_]+)"/gi;
let sm;
let count = 0;
while ((sm = simpleRe.exec(decoded)) !== null) {
  count++;
  console.log(`Simple match ${count}:`, sm[1]);
}
