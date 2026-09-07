import { gotScraping } from 'got-scraping';

// Step 1: Get embed URL from garageband
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;
console.log('1. Embed URL:', embedUrl.slice(0, 80));

// Step 2: Fetch embed page to get metaApi URL
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Extract origin from embed URL
const origin = new URL(embedUrl).origin;
console.log('2. Origin:', origin);

// Step 3: Fetch token from generate.php
const tokenRes = await gotScraping(origin + '/generate.php', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const token = tokenRes.body.trim();
console.log('3. Token:', token.slice(0, 50), '...');

// Step 4: Fetch API data with stream_urls
const metaApiUrl = 'https://data.vidsrcme.ru/api.php?type=movie&imdb=tt1375666&stream_urls';
const apiRes = await gotScraping(metaApiUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const apiData = JSON.parse(apiRes.body);

// Step 5: Decrypt stream_urls using WASM
const wasmRes = await gotScraping(apiData.vs.wasm_url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 10000 }, throwHttpErrors: false, responseType: 'buffer',
});
const wasmModule = await WebAssembly.compile(wasmRes.body);
const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
const { memory, alloc, decrypt } = wasmInstance.exports;

const enc = Buffer.from(apiData.data.stream_urls, 'base64');
const ptr = alloc(enc.length);
new Uint8Array(memory.buffer, ptr, enc.length).set(enc);
const outLen = decrypt(ptr, enc.length);
const output = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 12, outLen));
const streamUrls = output.split('\n').filter(s => s);
console.log('4. Decrypted stream URLs:', streamUrls.length);

// Step 6: Append token to each stream URL and test
for (const url of streamUrls) {
  const urlWithToken = url + (url.includes('?') ? '&' : '?') + 'token=' + token;
  console.log('\n5. Testing m3u8 with token:');
  console.log('   URL:', urlWithToken.slice(0, 100) + '...');
  
  const m3u8Res = await gotScraping(urlWithToken, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  console.log('   Status:', m3u8Res.statusCode, '| size:', m3u8Res.body.length);
  if (m3u8Res.statusCode === 200) {
    console.log('   Body (first 300):', m3u8Res.body.slice(0, 300));
  } else {
    console.log('   Body:', m3u8Res.body.slice(0, 100));
  }
  break; // Test first URL only
}
