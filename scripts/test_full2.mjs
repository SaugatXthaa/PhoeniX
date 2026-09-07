import { gotScraping } from 'got-scraping';

// Step 1: Get embed URL
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;
console.log('1. Embed:', embedUrl.slice(0, 80));

// Step 2: Fetch embed page → get playerUrl (has different vs=)
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const cfgMatch = embedRes.body.match(/"playerUrl"\s*:\s*"([^"]+)"/);
const playerUrl = cfgMatch?.[1]?.replace(/\\u0026/g, '&');
console.log('2. Player URL:', playerUrl?.slice(0, 80));

// Extract vs= from playerUrl
const playerVs = playerUrl?.match(/vs=([^&]+)/)?.[1];
console.log('   Player vs:', playerVs?.slice(0, 50));

// Step 3: Fetch generate.php with the PLAYER's vs= token
const origin = new URL(embedUrl).origin;
const genUrl = origin + '/embed/generate.php?vs=' + playerVs;
console.log('3. generate.php URL:', genUrl.slice(0, 100));

const tokenRes = await gotScraping(genUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + playerUrl },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('   Status:', tokenRes.statusCode, '| body:', tokenRes.body.slice(0, 100));

const token = tokenRes.body.trim();
console.log('   Token:', token.slice(0, 50));

if (token.length > 5 && !token.includes('<')) {
  // Step 4: Decrypt stream URLs
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
  console.log('4. Decrypted URLs:', streamUrls.length);
  
  // Step 5: Test m3u8 with token
  for (const url of streamUrls.slice(0, 1)) {
    const urlWithToken = url + (url.includes('?') ? '&' : '?') + 'token=' + token;
    console.log('5. Testing m3u8...');
    const m3u8Res = await gotScraping(urlWithToken, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
      timeout: { request: 10000 }, throwHttpErrors: false,
    });
    console.log('   Status:', m3u8Res.statusCode, '| size:', m3u8Res.body.length);
    if (m3u8Res.statusCode === 200) {
      console.log('   ✓ PLAYABLE!');
      console.log('   Body (first 500):', m3u8Res.body.slice(0, 500));
    } else {
      console.log('   Body:', m3u8Res.body.slice(0, 100));
    }
  }
}
