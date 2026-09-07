import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find the Yd function definition
const ydMatch = js.match(/(?:function\s+Yd|Yd\s*=\s*|var\s+Yd\s*=\s*)[^;]{0,500}/);
if (ydMatch) {
  console.log('Yd function:', ydMatch[0].slice(0, 300));
}

// Find Yd as an arrow function or const
const ydArrow = js.match(/Yd\s*=\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*[^;]{0,500}/);
if (ydArrow) {
  console.log('\nYd arrow:', ydArrow[0].slice(0, 300));
}

// Find the full detail function
const detailMatch = js.match(/detail\s*[:=]\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*[^;]{0,500}/);
if (detailMatch) {
  console.log('\ndetail function:', detailMatch[0].slice(0, 500));
}

// Find all references to Yd
const ydRefs = [...js.matchAll(/Yd\([^)]{0,200}\)/g)];
console.log('\nYd calls:');
for (const m of [...new Set(ydRefs.map(m => m[0]))].slice(0, 15)) {
  console.log('  ', m.slice(0, 150));
}

// Find the stream/sources function — search for "server" or "source" or "stream"
const streamFns = [...js.matchAll(/(\w+)\s*[:=]\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*Yd\([^)]+\)/g)];
console.log('\nFunctions calling Yd:');
for (const m of streamFns) {
  console.log('  ', m[1], '→', m[0].slice(m[0].indexOf('Yd'), m[0].indexOf('Yd') + 100));
}
