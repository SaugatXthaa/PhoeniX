import { gotScraping } from 'got-scraping';

const slug = 'r8bp4ny';

// POST to /embedhelper2.php with sid
const body = new URLSearchParams({
  sid: slug,
  UserFavSite: '',
  currentDomain: '["streams.iqsmartgames.com"]',
});

console.log('=== POST /embedhelper2.php ===');
const r = await gotScraping.post('https://pro.iqsmartgames.com/embedhelper2.php', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://pro.iqsmartgames.com/svid/rlDcHRz-PYpCeJCgTwdtnr00Y-VMpiKEtLTSmQ',
    'Origin': 'https://pro.iqsmartgames.com',
  },
  body: body.toString(),
  timeout: { request: 15000 },
  throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body.slice(0, 3000));
