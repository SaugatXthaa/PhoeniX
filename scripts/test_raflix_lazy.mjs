import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://raflixx.vercel.app/assets/index-1tmTi0g4.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find ALL lazy import() calls
const lazyImports = [...js.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g)];
console.log('Lazy imports:', lazyImports.length);
for (const m of [...new Set(lazyImports.map(m => m[1]))].slice(0, 20)) {
  console.log('  ', m);
}

// Find ALL chunk references
const chunks = [...js.matchAll(/["'`](\/assets\/[^"'`]+\.js)["'`]/g)];
console.log('\nChunk references:', chunks.length);
for (const m of [...new Set(chunks.map(m => m[1]))].slice(0, 20)) {
  console.log('  ', m);
}

// Find the watch route component (lazy loaded)
const watchRoute = [...js.matchAll(/watch[^;]{0,300}/gi)];
console.log('\nWatch references:');
for (const m of [...new Set(watchRoute.map(m => m[0]))].slice(0, 5)) {
  if (m.includes('import') || m.includes('lazy') || m.includes('chunk') || m.includes('assets')) {
    console.log('  ', m.slice(0, 200));
  }
}

// Search for the component that renders the video player
const playerComponent = [...js.matchAll(/(?:VideoPlayer|PlayerComponent|WatchPlayer|StreamPlayer|MediaPlayer|HlsPlayer)[^;]{0,300}/gi)];
console.log('\nPlayer components:');
for (const m of playerComponent.slice(0, 5)) {
  console.log('  ', m[0].slice(0, 200));
}

// Search for iframe src= patterns (where the embed URL is set)
const iframeSrc = [...js.matchAll(/iframe[^;]{0,200}src[^;]{0,200}/gi)];
console.log('\nIframe src patterns:');
for (const m of [...new Set(iframeSrc.map(m => m[0]))].slice(0, 5)) {
  console.log('  ', m.slice(0, 200));
}

// Search for "src=" assignments that build URLs
const srcAssignments = [...js.matchAll(/src\s*[:=]\s*[^;,}]{5,150}/gi)];
console.log('\nSrc assignments (filtered):');
for (const m of [...new Set(srcAssignments.map(m => m[0]))].slice(0, 20)) {
  if (m.includes('http') || m.includes('embed') || m.includes('player') || m.includes('stream') || m.includes('watch')) {
    console.log('  ', m.slice(0, 150));
  }
}
