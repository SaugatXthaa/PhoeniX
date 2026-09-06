import { gotScraping } from 'got-scraping';

const id = 'tt32820897';
const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';

const r = await gotScraping(`https://streams.iqsmartgames.com/mymovieapi?imdbid=${id}&key=${key}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
const data = JSON.parse(r.body);
console.log('Keys:', Object.keys(data));
console.log('Full response (first 3000):', JSON.stringify(data, null, 2).slice(0, 3000));
