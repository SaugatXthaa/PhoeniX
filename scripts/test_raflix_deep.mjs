import { gotScraping } from 'got-scraping';
import fs from 'fs';

const r = await gotScraping('https://raflixx.vercel.app/assets/index-1tmTi0g4.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;
fs.writeFileSync('/tmp/rf_full.js', js);
console.log('JS size:', js.length);

// Find ALL /api/ paths
const apiPaths = [...js.matchAll(/["'`]\/api\/([^"'`\s]+)["'`]/g)];
console.log('\nAll /api/ paths:');
for (const m of [...new Set(apiPaths.map(m => '/api/' + m[1]))].sort()) {
  console.log('  ', m);
}

// Find ALL fetch calls
const fetches = [...js.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/g)];
console.log('\nAll fetch URLs:');
for (const m of [...new Set(fetches.map(m => m[1]))].sort()) {
  console.log('  ', m);
}

// Find ALL template literal fetches
const templateFetches = [...js.matchAll(/fetch\(`([^`]+)`/g)];
console.log('\nTemplate fetch URLs:');
for (const m of [...new Set(templateFetches.map(m => m[1]))].sort()) {
  console.log('  ', m);
}

// Find ALL external URLs (non-standard)
const urls = [...js.matchAll(/["'`](https?:\/\/[^"'`]{5,150})["'`]/g)];
console.log('\nExternal URLs:');
for (const m of [...new Set(urls.map(m => m[1]))].sort()) {
  if (!m.includes('google') && !m.includes('font') && !m.includes('cloudflare') && 
      !m.includes('react') && !m.includes('github') && !m.includes('w3.org') &&
      !m.includes('schema') && !m.includes('mozilla') && !m.includes('microsoft') &&
      !m.includes('x.com') && !m.includes('image.tmdb') && !m.includes('vercel') &&
      !m.includes('wsrv') && !m.includes('snapchat') && !m.includes('instagram') &&
      !m.includes('whatsapp') && !m.includes('youtube') && !m.includes('jsdelivr') &&
      !m.includes('unpkg')) {
    console.log('  ', m);
  }
}

// Find stream/embed/player/source patterns
console.log('\nStream/player patterns:');
const patterns = [
  /(?:stream|embed|player|source|server|quality|video|watch|play|hls|dash|m3u8)[a-zA-Z]*\s*[:=]\s*[^;,}]{5,100}/gi,
];
for (const p of patterns) {
  const matches = [...js.matchAll(p)];
  for (const m of [...new Set(matches.map(m => m[0]))].slice(0, 20)) {
    if (!m.includes('displayName') && !m.includes('playName') && !m.includes('react') && 
        !m.includes('sourceType') && !m.includes('sourceData') && !m.includes('StreamingPlatform')) {
      console.log('  ', m.slice(0, 120));
    }
  }
}

// Find the server/provider list
console.log('\nServer/provider configs:');
const serverConfigs = [...js.matchAll(/\{[^{}]*id:\s*["']([^"']+)["'][^{}]*name:\s*["']([^"']+)["'][^{}]*\}/g)];
for (const m of serverConfigs.slice(0, 10)) {
  console.log('  id:', m[1], '| name:', m[2]);
}

// Find iframe creation
console.log('\nIframe/video patterns:');
const iframes = [...js.matchAll(/(?:iframe|createElement\(["']video)/gi)];
console.log('  iframe/video refs:', iframes.length);

// Find hls.js or video player library
const playerLibs = [...js.matchAll(/(?:hls\.js|video\.js|plyr|shaka|dashjs|MediaSource|hls\.loadSource|hls\.attachMedia)/gi)];
console.log('  Player libs:', playerLibs.length);

// Find the actual stream URL builder
console.log('\nURL builders:');
const urlBuilders = [...js.matchAll(/(?:src|url|source|stream|file)\s*[:=]\s*`[^`]+`/g)];
for (const m of [...new Set(urlBuilders.map(m => m[0]))].slice(0, 10)) {
  if (m.includes('http') || m.includes('/api') || m.includes('embed') || m.includes('player') || m.includes('stream') || m.includes('watch')) {
    console.log('  ', m.slice(0, 150));
  }
}
