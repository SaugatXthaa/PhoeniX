import { gotScraping } from 'got-scraping';

// Step 1: Get embed URL (has vs= param)
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;
const embedParsed = new URL(embedUrl);
const vs = embedParsed.searchParams.get('vs');
const origin = embedParsed.origin;
console.log('vs token:', vs?.slice(0, 50));
console.log('origin:', origin);

// Step 2: Fetch generate.php WITH the vs= param
const genUrl = origin + '/embed/generate.php?vs=' + vs;
console.log('\nFetching generate.php with vs param...');
const tokenRes = await gotScraping(genUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', tokenRes.statusCode, '| body:', tokenRes.body.slice(0, 200));

const token = tokenRes.body.trim();
if (token.length > 10 && token.length < 100) {
  console.log('Token:', token);
  
  // Step 3: Fetch API + decrypt stream URLs
  const apiRes = await gotScraping('https://data.vidsrcme.ru/api.php?type=movie&imdb=tt1375666&stream_urls', {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  const apiData = JSON.parse(apiRes.body);
  
  // Download + compile WASM
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
  console.log('\nDecrypted URLs:', streamUrls.length);
  
  // Step 4: Test m3u8 with token
  for (const url of streamUrls.slice(0, 1)) {
    const urlWithToken = url + (url.includes('?') ? '&' : '?') + 'token=' + token;
    console.log('\nTesting m3u8 with token...');
    const m3u8Res = await gotScraping(urlWithToken, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
      timeout: { request: 10000 }, throwHttpErrors: false,
    });
    console.log('Status:', m3u8Res.statusCode, '| size:', m3u8Res.body.length);
    if (m3u8Res.statusCode === 200) {
      console.log('Body (first 500):', m3u8Res.body.slice(0, 500));
    } else {
      console.log('Body:', m3u8Res.body.slice(0, 100));
    }
  }
}
