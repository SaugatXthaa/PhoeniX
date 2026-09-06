import { gotScraping } from 'got-scraping';

const hshareId = 'Inception.(2010).1080p.Dual.Audio.(Hin-Eng).mkv';
const body = `action=hindshare_sign&d=${encodeURIComponent(hshareId)}`;
console.log('POST body:', body);

const r = await gotScraping.post('https://mvlink.blog/wp-admin/admin-ajax.php', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://mvlink.blog/1287',
    'Accept': 'application/json,*/*',
    'Origin': 'https://mvlink.blog',
  },
  body,
  timeout: { request: 15000 },
  throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body.slice(0, 500));
