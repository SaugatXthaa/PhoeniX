import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const url = 'https://hubcloud.cx/drive/search-recover.php?from_ac=v7mp35yF2sGDVuoiar_OOjH3DAuaCs';
const r = await gotScraping(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://new3.moviesdrive.christmas/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});

const scriptMatches = [...r.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
for (let i = 0; i < scriptMatches.length; i++) {
  console.log(`=== Script ${i} (${scriptMatches[i][1].length} chars) ===`);
  console.log(scriptMatches[i][1]);
  console.log('');
}
