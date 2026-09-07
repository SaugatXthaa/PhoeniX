import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://cloudorchestranova.com/embed/iframe_player/assets/player.js?v=1786492668', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const js = r.body;
console.log('Player.js size:', js.length);

// Search for token usage
const tokenRefs = [...js.matchAll(/token[^,;}{]{0,100}/gi)];
console.log('\nToken references:');
for (const m of [...new Set(tokenRefs.map(m => m[0]))].slice(0, 10)) {
  console.log('  ', m.slice(0, 100));
}

// Search for how m3u8 URL is built
const m3u8Refs = [...js.matchAll(/[^"'`]{0,50}m3u8[^"'`]{0,50}/gi)];
console.log('\nm3u8 references:');
for (const m of [...new Set(m3u8Refs.map(m => m[0]))].slice(0, 5)) {
  console.log('  ', m.slice(0, 150));
}

// Search for URL building with token
const urlBuild = [...js.matchAll(/(?:url|src|source|file|stream)\s*[+:=]\s*[^;]{5,150}/gi)];
console.log('\nURL building:');
for (const m of [...new Set(urlBuild.map(m => m[0]))].slice(0, 10)) {
  if (m.includes('token') || m.includes('m3u8') || m.includes('stream') || m.includes('url')) {
    console.log('  ', m.slice(0, 150));
  }
}

// Search for how the stream_urls are used after decryption
const streamUsage = [...js.matchAll(/stream_urls[^;]{0,200}/gi)];
console.log('\nstream_urls usage:');
for (const m of streamUsage.slice(0, 5)) {
  console.log('  ', m[0].slice(0, 200));
}

// Look for the fetch call that gets the API data
const fetchCalls = [...js.matchAll(/fetch\([^)]+\)/g)];
console.log('\nFetch calls:');
for (const m of fetchCalls) {
  console.log('  ', m[0].slice(0, 200));
}
