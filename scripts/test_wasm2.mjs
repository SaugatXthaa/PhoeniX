import fs from 'fs';
import { gotScraping } from 'got-scraping';

// Download WASM with proper handling
const wasmRes = await gotScraping('https://data.vidsrcme.ru/wasm.php?w=5962534&_=1788760437', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false,
  responseType: 'buffer',
});
console.log('WASM status:', wasmRes.statusCode, '| size:', wasmRes.body.length);
console.log('Content-Type:', wasmRes.headers['content-type']);
console.log('Content-Encoding:', wasmRes.headers['content-encoding']);

const wasmBytes = wasmRes.body;
console.log('First 8 bytes (hex):', Buffer.from(wasmBytes.slice(0, 8)).toString('hex'));
fs.writeFileSync('/tmp/vs_decoder2.wasm', wasmBytes);

// Try compiling
try {
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const wasmInstance = await WebAssembly.instantiate(wasmModule, { env: { abort: () => {} } });
  console.log('WASM exports:', Object.keys(wasmInstance.exports));
  
  // Check all exports
  for (const [name, val] of Object.entries(wasmInstance.exports)) {
    if (typeof val === 'function') {
      console.log(`  ${name}: function(${val.length} args)`);
    } else if (val instanceof WebAssembly.Memory) {
      console.log(`  ${name}: Memory (size: ${val.buffer.byteLength})`);
    } else {
      console.log(`  ${name}: ${typeof val} = ${val}`);
    }
  }
} catch (e) {
  console.log('Compile error:', e.message);
  // Try without the first bytes (maybe there's a header)
  console.log('First 32 bytes:', Buffer.from(wasmBytes.slice(0, 32)).toString('hex'));
}
