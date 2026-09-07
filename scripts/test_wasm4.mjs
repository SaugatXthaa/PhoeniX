import { gotScraping } from 'got-scraping';

// Step 1: Fetch API data
const apiRes = await gotScraping('https://data.vidsrcme.ru/api.php?type=movie&imdb=tt1375666&stream_urls', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const apiData = JSON.parse(apiRes.body);
const encryptedB64 = apiData.data.stream_urls;
const vs = apiData.vs;

// Step 2: Download WASM
const wasmRes = await gotScraping(vs.wasm_url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false,
  responseType: 'buffer',
});

// Step 3: Compile + instantiate WASM
const wasmModule = await WebAssembly.compile(wasmRes.body);
const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
const { memory, alloc, decrypt } = wasmInstance.exports;

// Step 4: Decrypt
const enc = Buffer.from(encryptedB64, 'base64');
const ptr = alloc(enc.length);
new Uint8Array(memory.buffer, ptr, enc.length).set(enc);
const outLen = decrypt(ptr, enc.length);

// Read output from ptr + 12, length outLen
const output = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 12, outLen));
console.log('Decrypted stream URLs:');
console.log(output);

// Split by newlines to get individual URLs
const urls = output.split('\n').filter(s => s);
console.log('\nStream URLs found:', urls.length);
for (const u of urls) {
  console.log('  ', u);
}
