import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();

// Step 1: Visit the embed page to get cookies
console.log('Step 1: Visit embed page');
const r1 = await gotScraping('https://hanerix.com/e/idai5wak9cv0', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://pro.iqsmartgames.com/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r1.statusCode, '| cookies:', cookieJar.toJSON().cookies.length);

// Get file_id from the page
const fileIdMatch = r1.body.match(/file_id['"\s:=]+['"]?(\d+)/);
const fileId = fileIdMatch?.[1];
console.log('file_id:', fileId);

// Step 2: Call /api/source/{file_id} with cookies
if (fileId) {
  console.log('\nStep 2: POST /api/source/' + fileId);
  const r2 = await gotScraping.post(`https://hanerix.com/api/source/${fileId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Chrome/131',
      'Accept': 'application/json',
      'Referer': 'https://hanerix.com/e/idai5wak9cv0',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    cookieJar,
    body: `api_source=1&file_id=${fileId}`,
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  console.log('Status:', r2.statusCode, '| size:', r2.body.length);
  console.log('Body:', r2.body.slice(0, 1000));
}
