import { gotScraping } from 'got-scraping';

const url = 'https://hshare.ink/?id=Death.Note.Relight.1.Visions.Of.A.God.2007.720p.Bluray.Hindi.Japanese.mkv';
const r = await gotScraping(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body);
