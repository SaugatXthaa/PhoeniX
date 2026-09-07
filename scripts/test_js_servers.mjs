import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Search for server configurations — the app has 9 servers
// Look for arrays of server objects or URLs
const serverArrays = [...js.matchAll(/\[([^[\]]{10,500}(?:server|source|stream|embed|vidsrc|garageband|proxy|cloud|player)[^[\]]{10,500})\]/gi)];
console.log('Server arrays with keywords:', serverArrays.length);
for (const m of serverArrays.slice(0, 3)) {
  console.log('  ', m[0].slice(0, 300));
  console.log();
}

// Look for URL patterns that include "embed" or "stream" or "player"
const urlPatterns = [...js.matchAll(/["'`](https?:\/\/[^"'`]{5,150})["'`]/gi)];
console.log('\nAll URLs in JS:');
for (const m of [...new Set(urlPatterns.map(m => m[1]))]) {
  if (!m.includes('google') && !m.includes('font') && !m.includes('cloudflare') && 
      !m.includes('react') && !m.includes('github') && !m.includes('w3.org') &&
      !m.includes('schema') && !m.includes('mozilla') && !m.includes('microsoft') &&
      !m.includes('x.com') && !m.includes('image.tmdb')) {
    console.log('  ', m);
  }
}

// Look for template literals that build embed URLs
const templates = [...js.matchAll(/`([^`]*https?:\/\/[^`]*\$\{[^`]+[^`]*)`/g)];
console.log('\nURL templates:');
for (const m of [...new Set(templates.map(m => m[1]))]) {
  console.log('  ', m.slice(0, 200));
}

// Look for server names/labels
const serverLabels = [...js.matchAll(/["'`]([^"'`]*(?:Server|server|Source|source|Stream|stream|Quality|quality|4K|1080|720|480)[^"'`]{0,50})["'`]/gi)];
console.log('\nServer/quality labels:');
for (const m of [...new Set(serverLabels.map(m => m[1]))].slice(0, 20)) {
  if (m.length > 3 && m.length < 80) console.log('  ', m);
}

// Look for the server switch function
const switchFns = [...js.matchAll(/(?:handleServer|switchServer|selectServer|setServer|changeServer|onServerClick)\s*[:=(][^;]{0,300}/gi)];
console.log('\nServer switch functions:');
for (const m of switchFns.slice(0, 3)) {
  console.log('  ', m[0].slice(0, 200));
}

// Search for "garageband" specifically
const garageband = [...js.matchAll(/garageband[^"'`\s]{0,100}/gi)];
console.log('\nGarageband references:', garageband.length);
for (const m of garageband) console.log('  ', m[0]);

// Search for "proxy.garageband"
const proxyGb = [...js.matchAll(/proxy\.garageband[^"'`\s]{0,100}/gi)];
console.log('\nProxy garageband references:', proxyGb.length);
for (const m of proxyGb) console.log('  ', m[0]);

// Search for "vidsrc" 
const vidsrc = [...js.matchAll(/vidsrc[^"'`\s]{0,100}/gi)];
console.log('\nVidsrc references:', vidsrc.length);
for (const m of vidsrc) console.log('  ', m[0]);

// Search for "embed" URLs
const embedUrls = [...js.matchAll(/["'`](https?:\/\/[^"'`]*embed[^"'`]*)["'`]/gi)];
console.log('\nEmbed URLs:');
for (const m of [...new Set(embedUrls.map(m => m[1]))]) console.log('  ', m);

// Search for "cloudorchestranova"
const cloudOrch = [...js.matchAll(/cloudorchestranova[^"'`\s]{0,100}/gi)];
console.log('\nCloudOrchestranova references:', cloudOrch.length);
