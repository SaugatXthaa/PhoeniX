import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://new3.moviesdrive.christmas/naruto-season-1-9/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Check for mdrive.lol
const mdriveMatches = [...r.body.matchAll(/href="(https:\/\/mdrive\.lol\/archive\/\d+\/?)"/gi)];
console.log('mdrive.lol links:', mdriveMatches.length);

// Check for "Single Episode" text near mdrive
const singleEpMatches = [...r.body.matchAll(/href="(https:\/\/mdrive\.lol\/archive\/\d+\/?)"[^>]*>([\s\S]{0,200}?)<\/a>/gi)];
for (const m of singleEpMatches.slice(0, 5)) {
  console.log('  URL:', m[1]);
  console.log('  text:', m[2].replace(/<[^>]+>/g, '').trim());
}

// The links marked "480p Single Episode" go to hubcloud.foo - let me check what they actually are
// Maybe they're season archive pages, not episode pages
const decoded = r.body.replace(/&amp;/g, '&');
const re = /<a[^>]+href="(https:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?from_ac=[A-Za-z0-9_-]+(?:&q=[A-Za-z0-9+/=_-]+)?)"[^>]*>([\s\S]*?)<\/a>/gi;
let m;
const linkTexts = new Set();
while ((m = re.exec(decoded)) !== null) {
  const text = m[2].replace(/<[^>]+>/g, '').trim();
  linkTexts.add(text);
}
console.log('\nAll hubcloud link texts:');
for (const t of [...linkTexts].sort()) console.log('  ', t);
