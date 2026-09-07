import { gotScraping } from 'got-scraping';

// Quick test: fetch /embed/generate.php?vs=... and check the full response
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;

const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const cfgMatch = embedRes.body.match(/"playerUrl"\s*:\s*"([^"]+)"/);
const playerUrl = cfgMatch?.[1]?.replace(/\\u0026/g, '&');
const origin = new URL(embedUrl).origin;
const fullPlayerUrl = origin + playerUrl;

// Fetch player page first
const playerRes = await gotScraping(fullPlayerUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const playerVs = playerUrl.match(/vs=([^&]+)/)?.[1];

// Fetch generate.php
const genRes = await gotScraping(origin + '/embed/generate.php?vs=' + playerVs, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': fullPlayerUrl, 'Accept': '*/*' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', genRes.statusCode);
console.log('Headers:', JSON.stringify(genRes.headers, null, 2).slice(0, 500));
console.log('Body (first 1000):', genRes.body.slice(0, 1000));
