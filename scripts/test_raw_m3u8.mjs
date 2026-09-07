import { gotScraping } from 'got-scraping';

// Re-run the full chain to get a fresh token
// Step 1: Get embed URL
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;
const origin = new URL(embedUrl).origin;

// Step 2: Fetch API + decrypt
const apiRes = await gotScraping('https://data.vidsrcme.ru/api.php?type=movie&imdb=tt1375666&stream_urls', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const apiData = JSON.parse(apiRes.body);

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

// Step 3: Get token from the stream host
const streamHost = new URL(streamUrls[0]).hostname;
console.log('Stream host:', streamHost);

const tokenRes = await gotScraping(`https://${streamHost}/generate.php`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const token = tokenRes.body.trim();
console.log('Token:', token.slice(0, 50));

// Step 4: Test m3u8 with token
const m3u8Url = streamUrls[0] + '?token=' + token;
console.log('\n=== Testing m3u8 ===');
const m3u8Res = await gotScraping(m3u8Url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', m3u8Res.statusCode, '| size:', m3u8Res.body.length);
if (m3u8Res.statusCode === 200) {
  console.log('Body (first 500):', m3u8Res.body.slice(0, 500));
} else {
  console.log('Body:', m3u8Res.body.slice(0, 200));
}
