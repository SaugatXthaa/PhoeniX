import { gotScraping } from 'got-scraping';

// Step 1: Get embed URL
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;

// Step 2: Fetch embed page
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Extract playerUrl
const cfgMatch = embedRes.body.match(/window\.CFG\s*=\s*(\{.*?\})\s*;/s);
let playerUrl = null;
let metaApi = null;
if (cfgMatch) {
  const cfgStr = cfgMatch[1].replace(/\\u0026/g, '&');
  try {
    const cfg = JSON.parse(cfgStr);
    playerUrl = cfg.playerUrl;
    metaApi = cfg.metaApi;
  } catch {}
}

const origin = new URL(embedUrl).origin;
const fullPlayerUrl = origin + playerUrl;
console.log('Player URL:', fullPlayerUrl.slice(0, 80));

// Step 3: Fetch the player page  
const playerRes = await gotScraping(fullPlayerUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Player status:', playerRes.statusCode);

// Step 4: Extract the vs= param from the player URL
const playerVs = playerUrl.match(/vs=([^&]+)/)?.[1];
console.log('Player vs:', playerVs?.slice(0, 30));

// Step 5: Try generate.php with different approaches
// The player.js uses: fetchToken(origin + '/generate.php')
// But origin = window.location.origin which is cloudorchestranova.com
// So it's: https://cloudorchestranova.com/generate.php
// That returned 404 earlier. Maybe it's actually at /embed/generate.php
// and the player.js uses a relative URL

// Check what "origin" means in the player.js context
// If the player page is at cloudorchestranova.com/embed/player/movie/tt1375666
// then window.location.origin = https://cloudorchestranova.com
// And generate.php = https://cloudorchestranova.com/generate.php (404)

// But wait — maybe the player page is loaded inside an iframe from a different origin
// Let me check if the player page has a <base> tag or if origin is overridden
const baseTag = playerRes.body.match(/<base[^>]*href="([^"]+)"/i);
console.log('Base tag:', baseTag?.[1] || 'none');

// Look for origin override in the player.js
const originOverride = playerRes.body.match(/origin\s*[:=]\s*["']([^"']+)["']/i);
console.log('Origin override:', originOverride?.[1] || 'none');

// The player.js source code said:
// "var tokenReq = origin ? fetchToken(origin + '/generate.php') : Promise.resolve('')"
// So origin is a variable, not window.location.origin
// Let me find where origin is set in player.js

// Actually, let me just try ALL possible generate.php paths with the player's vs= param
const paths = [
  '/generate.php',
  '/embed/generate.php', 
  '/embed/player/generate.php',
  '/embed/iframe_player/generate.php',
];

for (const p of paths) {
  const url = origin + p + '?vs=' + playerVs;
  const r = await gotScraping(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': fullPlayerUrl },
    timeout: { request: 5000 }, throwHttpErrors: false,
  });
  const body = r.body.slice(0, 100);
  if (r.statusCode !== 404 && !body.includes('Expired') && !body.includes('<!')) {
    console.log(`✓ ${p}?vs=...: ${r.statusCode} → ${body}`);
  } else {
    console.log(`✗ ${p}?vs=...: ${r.statusCode} → ${body.slice(0, 50)}`);
  }
}
