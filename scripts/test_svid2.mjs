import { gotScraping } from 'got-scraping';

const slug = 'r8bp4ny';

const r = await gotScraping(`https://pro.iqsmartgames.com/evid/${slug}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://streams.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});

// Find ALL script tags
const scripts = [...r.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
console.log('Script tags:', scripts.length);
for (let i = 0; i < scripts.length; i++) {
  const content = scripts[i][1].trim();
  if (content.length > 50 && content.length < 5000) {
    console.log(`\n=== Script ${i} (${content.length} chars) ===`);
    console.log(content.slice(0, 2000));
  }
}

// Look for ALL JS variables
console.log('\n=== JS variables ===');
const vars = r.body.match(/(?:let|var|const)\s+\w+\s*=\s*[^;]+;/g);
if (vars) for (const v of vars.slice(0, 20)) console.log('  ', v.slice(0, 150));

// Look for fetch/ajax calls
console.log('\n=== Fetch/Ajax calls ===');
const fetches = r.body.match(/(?:fetch|ajax|XMLHttpRequest|\$\.(?:get|post|ajax))\([^)]+\)/gi);
if (fetches) for (const f of fetches) console.log('  ', f.slice(0, 200));

// Look for hls/videojs/jwplayer
console.log('\n=== Player references ===');
const players = r.body.match(/(?:hls|videojs|jwplayer|flowplayer|clappr|plyr|shaka|dashjs)\.?[a-zA-Z]*/gi);
if (players) console.log('  ', [...new Set(players)].join(', '));
