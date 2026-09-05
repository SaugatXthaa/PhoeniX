import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://mdrive.lol/archive/13475/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Look for hubcloud links
const hubLinks = [...r.body.matchAll(/href="(https:\/\/hubcloud\.[^"]+)"/gi)];
console.log('hubcloud links:', hubLinks.length);
for (const m of hubLinks.slice(0, 3)) console.log('  ', m[1]);

// Look for ANY download links
const dlLinks = [...r.body.matchAll(/href="(https:\/\/[^"]+)"/gi)];
console.log('\nAll https links:', dlLinks.length);
const hosts = new Set();
for (const m of dlLinks) {
  try { hosts.add(new URL(m[1]).hostname); } catch {}
}
console.log('Hosts:', [...hosts].sort());

// Look for episode markers
const epMarkers = [...r.body.matchAll(/(Ep\d+|Episode\s*\d+)/gi)];
console.log('\nEpisode markers:', epMarkers.length);
for (const m of epMarkers.slice(0, 5)) console.log('  ', m[0]);

// Show page sample
console.log('\nPage sample (first 2000):');
console.log(r.body.slice(0, 2000));
