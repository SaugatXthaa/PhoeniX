import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Look for relative URL paths (starting with /)
const relPaths = [...js.matchAll(/["'`](\/[a-z][a-z0-9/_-]{3,50})["'`]/gi)];
console.log('Relative paths:');
for (const m of [...new Set(relPaths.map(m => m[1]))].sort()) {
  if (!m.includes('assets/') && !m.includes('wp-') && !m.includes('icon')) {
    console.log('  ', m);
  }
}

// Look for template literals with ${} that build URLs
const templates = [...js.matchAll(/`([^`]*\$\{[^`]*\}[^`]*)`/g)];
console.log('\nTemplate literals with URLs:');
for (const m of [...new Set(templates.map(m => m[1]))]) {
  if (/\/(api|stream|video|embed|player|source|watch|server|movie|tv)/i.test(m)) {
    console.log('  ', m.slice(0, 150));
  }
}

// Look for the video player setup (HLS, video element, etc.)
const playerSetup = [...js.matchAll(/(?:Hls|MediaSource|video\.src|createElement\(['"]video|canPlayType|application\/vnd\.apple\.mpegurl)[^;]{0,200}/gi)];
console.log('\nPlayer setup:');
for (const m of playerSetup) console.log('  ', m[0].slice(0, 150));

// Look for the "detail" function (referenced in routes as f.detail)
const detailFn = [...js.matchAll(/detail\s*[:=]\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*\{?[^}]{0,500}/gi)];
console.log('\ndetail function:');
for (const m of detailFn.slice(0, 3)) console.log('  ', m[0].slice(0, 200));
