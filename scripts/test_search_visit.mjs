import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

// Visit the search page (not API) — it might have different URL format
const token = '8W0C7p_M8CnyjGAaktlqJDkbMvk4qkcz_JKxRvUDSNsigBjyNwpM';
const searchPageUrl = `https://hubcloud.cx/drive/search-recover.php?from_ac=${token}&q=Naruto+S01E01+1080p`;
console.log('Visiting search page:', searchPageUrl.slice(0, 100));
const r = await gotScraping(searchPageUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Look for any /drive/ links in the page
const driveLinks = [...r.body.matchAll(/href="(https:\/\/hubcloud\.cx\/drive\/[^"]+)"/gi)];
console.log('\n/drive/ links:', driveLinks.length);
for (const m of driveLinks.slice(0, 5)) {
  console.log('  ', m[1]);
}

// Also look for the file IDs and any other URL patterns
const fileIdMatches = [...r.body.matchAll(/\/drive\/([A-Za-z0-9_]+)/g)];
console.log('\nFile IDs:', fileIdMatches.length);
const ids = new Set();
for (const m of fileIdMatches) ids.add(m[1]);
for (const id of [...ids].slice(0, 5)) console.log('  ', id);

// Show page sample
console.log('\nPage sample (last 2000 chars):');
console.log(r.body.slice(-2000));
