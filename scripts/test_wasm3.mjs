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

// Step 3: Compile WASM
const wasmModule = await WebAssembly.compile(wasmRes.body);
const wasmInstance = await WebAssembly.instantiate(wasmModule, { env: { abort: () => {} } });
const { memory, alloc, decrypt, stat, meta, sync } = wasmInstance.exports;

console.log('WASM loaded. Memory size:', memory.buffer.byteLength);

// Step 4: Decode base64 encrypted data
const encryptedBytes = Buffer.from(encryptedB64, 'base64');
console.log('Encrypted bytes:', encryptedBytes.length);

// Step 5: Look at the vsdec.js source to understand the decrypt call
// From vsdec.js:
//   - nonce = first 12 bytes
//   - ciphertext = rest
//   - alloc(size) → returns pointer
//   - write data to memory at pointer
//   - decrypt(noncePtr, cipherPtr) → returns result
//   - read output from memory

// But actually, let me re-read vsdec.js more carefully
// The function signature is decrypt(2 args) — let me try different approaches

// Approach 1: alloc input buffer, write encrypted data, call decrypt
const inputLen = encryptedBytes.length;
const inputPtr = alloc(inputLen);
console.log('Input ptr:', inputPtr);

// Write encrypted bytes to WASM memory
const memView = new Uint8Array(memory.buffer);
memView.set(encryptedBytes, inputPtr);

// Call decrypt(inputPtr, inputLen) — maybe it returns a pointer to decrypted data
const result = decrypt(inputPtr, inputLen);
console.log('Decrypt result:', result);

// Try reading the result as a pointer to a string
if (result > 0 && result < memory.buffer.byteLength) {
  // Read the output string (null-terminated)
  let output = '';
  let i = result;
  while (i < memory.buffer.byteLength) {
    const byte = memView[i];
    if (byte === 0) break;
    output += String.fromCharCode(byte);
    i++;
  }
  console.log('Decrypted output (as string):', output.slice(0, 500));
} else {
  console.log('Result is not a valid pointer');
  // Maybe decrypt returns the length, and the output is at inputPtr
  // Try reading from inputPtr
  let output2 = '';
  let j = inputPtr;
  while (j < memory.buffer.byteLength) {
    const byte = memView[j];
    if (byte === 0) break;
    output2 += String.fromCharCode(byte);
    j++;
  }
  console.log('Output at inputPtr:', output2.slice(0, 500));
}

// Also try stat and meta
console.log('\nstat(inputPtr):', stat(inputPtr));
console.log('meta(inputPtr):', meta(inputPtr));
console.log('sync(inputPtr):', sync(inputPtr));
