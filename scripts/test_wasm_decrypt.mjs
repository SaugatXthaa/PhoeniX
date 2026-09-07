import fs from 'fs';
import { gotScraping } from 'got-scraping';

// Step 1: Fetch the API response
const apiRes = await gotScraping('https://data.vidsrcme.ru/api.php?type=movie&imdb=tt1375666&stream_urls', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const apiData = JSON.parse(apiRes.body);
const encryptedStreamUrls = apiData.data.stream_urls;
const vs = apiData.vs;
console.log('Encrypted stream_urls length:', encryptedStreamUrls.length);
console.log('VS:', JSON.stringify(vs));

// Step 2: Download the WASM file
const wasmRes = await gotScraping(vs.wasm_url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const wasmBytes = Buffer.from(wasmRes.body, 'binary');
console.log('WASM size:', wasmBytes.length);
fs.writeFileSync('/tmp/vs_decoder.wasm', wasmBytes);

// Step 3: Load and instantiate the WASM module
try {
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const wasmInstance = await WebAssembly.instantiate(wasmModule, {
    env: {
      // Common WASM imports — provide empty implementations
      abort: () => {},
      emscripten_notify_memory_growth: () => {},
    },
  });
  
  console.log('WASM exports:', Object.keys(wasmInstance.exports));
  
  // The vsdec.js shows the decryption flow:
  // 1. Base64 decode the encrypted string
  // 2. First 12 bytes = nonce, rest = ciphertext
  // 3. Call the WASM decrypt function with nonce + ciphertext
  
  // Decode base64
  const encryptedBytes = Buffer.from(encryptedStreamUrls, 'base64');
  console.log('Encrypted bytes length:', encryptedBytes.length);
  
  // Extract nonce (first 12 bytes) and ciphertext (rest)
  const nonce = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12);
  console.log('Nonce length:', nonce.length, '| Ciphertext length:', ciphertext.length);
  
  // Try calling the WASM decrypt function
  // Look for a decrypt/decode function in the exports
  const exports = wasmInstance.exports;
  const exportNames = Object.keys(exports);
  console.log('Export names:', exportNames);
  
  // Common patterns: decrypt, decode, chacha20_decrypt
  for (const name of exportNames) {
    if (typeof exports[name] === 'function') {
      console.log(`Export "${name}": typeof = function, length = ${exports[name].length}`);
    } else {
      console.log(`Export "${name}": typeof = ${typeof exports[name]}, value = ${exports[name]}`);
    }
  }
  
  // Try to allocate memory and call the decrypt function
  if (exports.malloc && exports.free) {
    // C-style allocation
    const noncePtr = exports.malloc(nonce.length);
    const cipherPtr = exports.malloc(ciphertext.length);
    const outputPtr = exports.malloc(ciphertext.length); // output should be same size or smaller
    
    // Write nonce and ciphertext to WASM memory
    const memory = exports.memory || exports.__heap_base;
    // ... this gets complex. Let me check what functions are available
  }
} catch (e) {
  console.log('WASM error:', e.message);
}
