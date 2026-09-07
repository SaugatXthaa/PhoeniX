import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Search for "server" references (streaming servers)
const serverRefs = [...js.matchAll(/server[^,}]{0,150}/gi)];
console.log('Server references:');
for (const m of [...new Set(serverRefs.map(m => m[0]))].slice(0, 15)) {
  if (m.length > 10 && !m.includes('serverSide') && !m.includes('serverName')) {
    console.log('  ', m.slice(0, 150));
  }
}

// Search for "source" references (stream sources)
const sourceRefs = [...js.matchAll(/source[s]?\s*[:=]\s*[^,;}]{5,100}/gi)];
console.log('\nSource references:');
for (const m of [...new Set(sourceRefs.map(m => m[0]))].slice(0, 15)) {
  if (!m.includes('sourceType') && !m.includes('react')) {
    console.log('  ', m.slice(0, 150));
  }
}

// Search for iframe or video element creation
const iframeRefs = [...js.matchAll(/iframe[^,}]{0,200}/gi)];
console.log('\nIframe references:');
for (const m of [...new Set(iframeRefs.map(m => m[0]))].slice(0, 5)) {
  if (m.length > 20) console.log('  ', m.slice(0, 150));
}

// Search for "stream" function
const streamRefs = [...js.matchAll(/stream[s]?\s*[:=]\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*[^;]{0,300}/gi)];
console.log('\nStream functions:');
for (const m of streamRefs.slice(0, 5)) {
  console.log('  ', m[0].slice(0, 200));
}

// Search for quality/resolution
const qualityRefs = [...js.matchAll(/quality\s*[:=]\s*[^,;}]{5,80}/gi)];
console.log('\nQuality references:');
for (const m of [...new Set(qualityRefs.map(m => m[0]))].slice(0, 10)) {
  console.log('  ', m.slice(0, 100));
}

// Look for any URL that could be a stream backend
const streamUrls = [...js.matchAll(/["'`](https?:\/\/[^"'`]*(?:stream|video|player|cdn|media|content|watch|play|embed|source)[^"'`]*)["'`]/gi)];
console.log('\nStream-like URLs:');
for (const m of [...new Set(streamUrls.map(m => m[1]))]) {
  if (!m.includes('google') && !m.includes('font') && !m.includes('cloudflare')) {
    console.log('  ', m);
  }
}
