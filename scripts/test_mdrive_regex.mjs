import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://mdrive.lol/archive/13475/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const decoded = r.body.replace(/&amp;/g, '&');

// Test the scraper's URL regex
const urlRe = /href="(https:\/\/hubcloud\.cx\/drive\/[A-Za-z0-9_]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
let um;
let count = 0;
while ((um = urlRe.exec(decoded)) !== null) {
  count++;
  console.log(`Match ${count}:`);
  console.log('  URL:', um[1]);
  console.log('  text:', um[2].replace(/<[^>]+>/g, '').trim().slice(0, 80));
}

// Also check: does the hubcloud link have an </a> after it?
const hubPos = decoded.indexOf('hubcloud.cx/drive/');
if (hubPos >= 0) {
  console.log('\nContext around hubcloud link:');
  console.log(decoded.slice(hubPos - 50, hubPos + 300));
}
