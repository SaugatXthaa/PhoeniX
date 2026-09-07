import { gotScraping } from 'got-scraping';

// The stream URL hostname is peregrinepalaver.space
// Try fetching generate.php from THERE
const r = await gotScraping('https://peregrinepalaver.space/generate.php', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode);
console.log('Body:', r.body.slice(0, 200));
