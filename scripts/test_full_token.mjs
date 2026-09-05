import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

// Get the Naruto page from moviesdrive
const r = await gotScraping('https://new3.moviesdrive.christmas/naruto-season-1-9/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Find ALL hubcloud links with full from_ac
const matches = [...r.body.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?from_ac=([^&"'<]+)&(?:amp;)?q=([^"'<\s]+))"/g)];
console.log('Found', matches.length, 'hubcloud links');
for (const m of matches.slice(0, 6)) {
  console.log('  from_ac (full):', m[2]);
  console.log('  q:', m[3], '→', Buffer.from(m[3], 'base64').toString('utf8'));
  console.log('---');
}
