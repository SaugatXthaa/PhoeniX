import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://streams.iqsmartgames.com/mymovieapi?imdbid=tt11032374&key=e11a7debaaa4f5d25b671706ffe4d2acb56efbd4', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body.slice(0, 1000));
