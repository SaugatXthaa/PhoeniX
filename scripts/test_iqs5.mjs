import { gotScraping } from 'got-scraping';

// Test with different IMDB IDs
const tests = [
  { imdb: 'tt1375666', name: 'Inception' },
  { imdb: 'tt32820897', name: 'Demon Slayer Infinity Castle' },
  { imdb: 'tt11032374', name: 'Demon Slayer Mugen Train' },
];

for (const t of tests) {
  // First get the embed page to extract the key
  const embedUrl = `https://streams.iqsmartgames.com/embed/movie/${t.imdb}`;
  console.log(`\n=== ${t.name} (${t.imdb}) ===`);
  
  // The key is in the embed page URL — but we need to get it from the DooPlay API
  // For now, test without key
  const r = await gotScraping(`https://streams.iqsmartgames.com/mymovieapi?imdbid=${t.imdb}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://streams.iqsmartgames.com/' },
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  console.log('  Status:', r.statusCode, '| body:', r.body.slice(0, 200));
}
