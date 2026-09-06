import { gotScraping } from 'got-scraping';

// The key from the DooPlay API for Demon Slayer Mugen Train
const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';
const imdb = 'tt11032374';

const r = await gotScraping(`https://streams.iqsmartgames.com/mymovieapi?imdbid=${imdb}&key=${key}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
console.log('Body:', r.body.slice(0, 1000));
