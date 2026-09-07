import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();

// Step 1: Get embed URL
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;
console.log('1. Embed:', embedUrl.slice(0, 80));

// Step 2: Fetch embed page (with cookies)
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('2. Embed page:', embedRes.statusCode, '| cookies:', cookieJar.toJSON().cookies.length);

// Get playerUrl from CFG
const cfgMatch = embedRes.body.match(/"playerUrl"\s*:\s*"([^"]+)"/);
const playerUrl = cfgMatch?.[1]?.replace(/\\u0026/g, '&');
const origin = new URL(embedUrl).origin;
const fullPlayerUrl = origin + playerUrl;
console.log('3. Player URL:', fullPlayerUrl.slice(0, 80));

// Step 3: Fetch player page (with cookies — this should set the token cookie)
const playerRes = await gotScraping(fullPlayerUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('4. Player page:', playerRes.statusCode, '| cookies:', cookieJar.toJSON().cookies.length);
for (const c of cookieJar.toJSON().cookies) {
  console.log('   Cookie:', c.key, '=', c.value.slice(0, 50));
}

// Step 4: Fetch generate.php (with cookies from player page)
const genRes = await gotScraping(origin + '/embed/generate.php', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': fullPlayerUrl },
  cookieJar,
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('5. generate.php:', genRes.statusCode, '| body:', genRes.body.slice(0, 200));
