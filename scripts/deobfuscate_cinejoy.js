// Deobfuscate cinejoy.to BkWcGVCU.js
// Downloads the chunk, extracts the string array + decoder, runs them, then decodes all strings

const { gotScraping } = await import('got-scraping');

const res = await gotScraping.get('https://cinejoy.to/_app/immutable/chunks/BkWcGVCU.js', {
  headers: { 'User-Agent': 'Mozilla/5.0' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: false,
});

let code = res.body;

// Extract the O() function
const oStart = code.indexOf('function O(){');
const oEnd = code.indexOf('return O=function(){return e},O()}';
const oFunc = code.slice(oStart, oEnd + 'return O=function(){return e},O()}'.length);

// Extract the u() function
const uStart = code.indexOf('function u(e,x){');
// Find the matching closing brace
let depth = 0;
let uEnd = uStart;
for (let i = uStart; i < code.length; i++) {
  if (code[i] === '{') depth++;
  if (code[i] === '}') { depth--; if (depth === 0) { uEnd = i + 1; break; } }
}
const uFunc = code.slice(uStart, uEnd);

// Extract the IIFE (array shuffler)
const iifeStart = code.indexOf('(function(e,x){');
const iifeEnd = code.indexOf('})(O,') + '})(O,'.length;
const iifeRest = code.indexOf(');', iifeEnd) + 2;
const iife = code.slice(iifeStart, iifeRest);

// Build the deobfuscator
const deobCode = oFunc + '\n' + uFunc + '\n' + iife + '\n';

// Now extract all u() calls from the original code to find the key strings
// Pattern: u(number, "key") or v(number, "key") or R(number, "key")
const uCalls = [...code.matchAll(/(?:u|v|R)\((\d+),\s*"([^"]+)"/g)];
const decodedMap = new Map();

// Create a function that evaluates the deobfuscator and decodes strings
const fn = new Function(deobCode + `
  // After the IIFE runs, O() returns the correctly shuffled array
  // u(e, x) decodes: e is the index+offset, x is the key
  // offset = 12349 + 257 * -47 = 270
  
  const results = {};
  const uCalls = ${JSON.stringify(uCalls.map(m => ({ index: parseInt(m[1]), key: m[2] })))};
  
  for (const call of uCalls) {
    try {
      const decoded = u(call.index, call.key);
      results[call.index + ':' + call.key] = decoded;
    } catch (e) {
      results[call.index + ':' + call.key] = 'ERROR: ' + e.message;
    }
  }
  
  return results;
`);

try {
  const results = fn();
  // Print all decoded strings, sorted by index
  const sorted = Object.entries(results).sort((a, b) => {
    const aIdx = parseInt(a[0].split(':')[0]);
    const bIdx = parseInt(b[0].split(':')[0]);
    return aIdx - bIdx;
  });
  
  console.log('Decoded strings:', sorted.length);
  for (const [key, value] of sorted) {
    const [idx, keyStr] = key.split(':');
    console.log(`u(${idx}, "${keyStr}") = "${value}"`);
  }
} catch (e) {
  console.log('Error:', e.message);
  console.log('Stack:', e.stack?.slice(0, 500));
}
