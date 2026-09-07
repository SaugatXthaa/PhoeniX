import { gotScraping } from 'got-scraping';

// Step 1: Get fresh embed URL
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;

// Step 2: Fetch embed page to get playerUrl
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const cfgMatch = embedRes.body.match(/"playerUrl"\s*:\s*"([^"]+)"/);
const playerUrl = cfgMatch?.[1]?.replace(/\\u0026/g, '&');
const origin = new URL(embedUrl).origin;
const fullPlayerUrl = origin + playerUrl;

// Step 3: Fetch the player page first (sets up server-side session)
const playerRes = await gotScraping(fullPlayerUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Player page:', playerRes.statusCode);

// Step 4: Fetch generate.php with the PLAYER page URL as Referer
const genRes = await gotScraping(origin + '/generate.php', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Referer': fullPlayerUrl,
    'Accept': '*/*',
  },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('generate.php:', genRes.statusCode, '| body:', genRes.body.slice(0, 200));

// If still 403, try with the vs= param from the player URL
const playerVs = playerUrl.match(/vs=([^&]+)/)?.[1];
console.log('Player vs:', playerVs?.slice(0, 30));

const genRes2 = await gotScraping(origin + '/generate.php?vs=' + playerVs, {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Referer': fullPlayerUrl,
  },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('generate.php?vs=...:', genRes2.statusCode, '| body:', genRes2.body.slice(0, 200));
