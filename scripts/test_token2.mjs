import { gotScraping } from 'got-scraping';

const origin = 'https://cloudorchestranova.com';

// Try different token endpoints
const endpoints = [
  '/generate.php',
  '/embed/generate.php',
  '/embed/player/generate.php',
  '/embed/iframe_player/generate.php',
  '/token.php',
  '/embed/token.php',
  '/api/token',
];

for (const ep of endpoints) {
  const r = await gotScraping(origin + ep, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
    timeout: { request: 5000 }, throwHttpErrors: false,
  });
  console.log(`${ep} → ${r.statusCode} (${r.body.length}b): ${r.body.slice(0, 100)}`);
}

// Also check the player.js for the EXACT generate.php path
const playerJs = await gotScraping(origin + '/embed/iframe_player/assets/player.js?v=1786492668', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});

// Find the exact context around generate.php
const genMatch = playerJs.body.match(/.{0,100}generate\.php.{0,100}/);
if (genMatch) console.log('\ngenerate.php context:', genMatch[0]);
