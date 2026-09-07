import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://cloudorchestranova.com/embed/iframe_player/assets/player.js?v=1786492668', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find ALL generate.php references with full context
const matches = [...js.matchAll(/.{0,200}generate\.php.{0,200}/g)];
console.log('generate.php references:');
for (const m of matches) {
  console.log('  ', m[0].replace(/\n/g, ' '));
  console.log();
}

// Also find how the token URL is constructed
const tokenUrlMatches = [...js.matchAll(/token_url[^;]{0,300}/gi)];
console.log('\ntoken_url construction:');
for (const m of tokenUrlMatches) {
  console.log('  ', m[0].slice(0, 200));
}
