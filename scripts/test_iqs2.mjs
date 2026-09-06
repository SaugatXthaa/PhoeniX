import { gotScraping } from 'got-scraping';

const id = 'tt32820897';
const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';

// Test techinmind.space
console.log('=== techinmind.space ===');
let r = await gotScraping(`https://stream.techinmind.space/movieapi2.php?imdbid=${id}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body.slice(0, 2000));

console.log('\n=== iqsmartgames /mymovieapi ===');
r = await gotScraping(`https://streams.iqsmartgames.com/mymovieapi?imdbid=${id}&key=${key}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body.slice(0, 2000));
