import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://cloudorchestranova.com/embed/iframe_player/assets/player.js?v=1786492668', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find token_url references
const tokenUrlRefs = [...js.matchAll(/token_url[^,;}{]{0,200}/gi)];
console.log('token_url references:');
for (const m of [...new Set(tokenUrlRefs.map(m => m[0]))]) {
  console.log('  ', m.slice(0, 200));
}

// Find the function that fetches the token
const fetchTokenFn = [...js.matchAll(/(?:fetch|get)Token[^;]{0,300}/gi)];
console.log('\nfetchToken function:');
for (const m of fetchTokenFn.slice(0, 3)) {
  console.log('  ', m[0].slice(0, 200));
}

// Find where token_url is set
const tokenUrlSet = [...js.matchAll(/token_url\s*[:=]\s*[^,;}{]{5,200}/gi)];
console.log('\ntoken_url assignment:');
for (const m of tokenUrlSet.slice(0, 5)) {
  console.log('  ', m[0].slice(0, 200));
}

// Find the full token fetch flow
const tokenFlow = [...js.matchAll(/fetch\([^)]*token[^)]*\)/gi)];
console.log('\nToken fetch calls:');
for (const m of tokenFlow.slice(0, 5)) {
  console.log('  ', m[0].slice(0, 200));
}

// Look for the actual URL pattern
const urlPatterns = [...js.matchAll(/["'`](https?:\/\/[^"'`]*(?:token|vs|api|get)[^"'`]*)["'`]/gi)];
console.log('\nToken-like URLs:');
for (const m of [...new Set(urlPatterns.map(m => m[1]))]) {
  console.log('  ', m);
}
