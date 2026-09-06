import { gotScraping } from 'got-scraping';

// The scraper uses admin-ajax.php to get the r.php URL
// Let me test what action it uses
const r = await gotScraping.post('https://mvlink.blog/wp-admin/admin-ajax.php', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://mvlink.blog/55951',
  },
  body: 'action=mvlink_get_link&post_id=55951',
  timeout: { request: 15000 },
  throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body.slice(0, 1000));
