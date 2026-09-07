import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find all function names that contain "server" or "stream" or "source" or "play"
const fnNames = [...js.matchAll(/(\w*(?:erver|tream|ource|lay|ideo|atch)\w*)\s*[:=(]/gi)];
console.log('Function names with stream/server/play:');
for (const m of [...new Set(fnNames.map(m => m[1]))].sort()) {
  if (m.length > 3) console.log('  ', m);
}

// Find the function that handles server selection (onClick)
const onClickFns = [...js.matchAll(/(?:onClick|onSelect|handleChange|selectServer|switchServer|setServer|changeServer)\s*[:=]\s*([^,}]{5,200})/gi)];
console.log('\nServer selection handlers:');
for (const m of onClickFns.slice(0, 10)) {
  console.log('  ', m[0].slice(0, 150));
}

// Look for the iframe src setter
const iframeSetters = [...js.matchAll(/(?:iframe|src)\s*[:=]\s*[^,;}]{5,150}/gi)];
console.log('\nIframe/src setters:');
for (const m of [...new Set(iframeSetters.map(m => m[0]))].slice(0, 10)) {
  if (m.includes('embed') || m.includes('stream') || m.includes('video') || m.includes('player') || m.includes('src')) {
    console.log('  ', m.slice(0, 150));
  }
}

// Look for any URL that contains "vidsrc" or "2embed" or "multiembed" or similar
const embedUrls = [...js.matchAll(/["'`](https?:\/\/[^"'`]*(?:vidsrc|2embed|multiembed| vidsrc|embed\.su|gomo|videasy|vidlink|vidking|vixsrc|streamx|fmovies|soap2day)[^"'`]*)["'`]/gi)];
console.log('\nKnown embed provider URLs:');
for (const m of [...new Set(embedUrls.map(m => m[1]))]) console.log('  ', m);

// Look for URL template patterns
const urlTemplates = [...js.matchAll(/["'`](https?:\/\/[^"'`]*\$\{[^"'`]+[^"'`]*)["'`]/gi)];
console.log('\nURL templates:');
for (const m of [...new Set(urlTemplates.map(m => m[1]))].slice(0, 10)) {
  console.log('  ', m.slice(0, 200));
}
