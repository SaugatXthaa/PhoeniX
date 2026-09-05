import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const url = 'https://hubcloud.cx/drive/search-recover.php?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCsbvpBzl7eRNeQbMTj1XfMdJ&q=RG93bmxvYWQgTmFydXRvIDQ4MHA';
console.log('Visiting Single Episode page:', url.slice(0, 100));
const r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Look for episode markers (Ep01, Ep02, etc.)
const epMatches = [...r.body.matchAll(/Ep(\d+)|Episode\s*(\d+)/gi)];
console.log('Episode markers:', epMatches.length);
for (const m of epMatches.slice(0, 5)) {
  console.log('  ', m[0], 'at pos', m.index);
}

// Look for hubcloud.cx/drive/<id> links (individual episodes)
const driveMatches = [...r.body.matchAll(/href="(https:\/\/hubcloud\.cx\/drive\/[A-Za-z0-9_]+)"/gi)];
console.log('\nhubcloud.cx/drive/ links:', driveMatches.length);
for (const m of driveMatches.slice(0, 5)) {
  console.log('  ', m[1]);
}

// Show a sample of the page
console.log('\nPage sample (chars 1000-3000):');
console.log(r.body.slice(1000, 3000));
