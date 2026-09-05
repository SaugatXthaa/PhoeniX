import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://new3.moviesdrive.christmas/naruto-season-1-9/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Decode HTML entities first (like the scraper does)
const decoded = r.body.replace(/&amp;/g, '&');

// Test the scraper's regex
const re = /<a[^>]+href="(https:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?from_ac=[A-Za-z0-9_-]+(?:&q=[A-Za-z0-9+/=_-]+)?)"[^>]*>([\s\S]*?)<\/a>/gi;
let m;
let count = 0;
while ((m = re.exec(decoded)) !== null) {
  count++;
  if (count <= 3) {
    console.log(`Match ${count}:`);
    console.log('  URL:', m[1]);
    // Extract from_ac
    const fromAcMatch = m[1].match(/from_ac=([A-Za-z0-9_-]+)/);
    console.log('  from_ac:', fromAcMatch?.[1]);
    console.log('  text:', m[2].replace(/<[^>]+>/g, '').trim().slice(0, 60));
    console.log('---');
  }
}
console.log('Total matches:', count);
