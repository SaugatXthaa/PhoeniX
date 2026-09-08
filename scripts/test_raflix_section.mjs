import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://raflixx.vercel.app/assets/index-1tmTi0g4.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Find the function that calls available-watch-providers
// The JS says: tn(e, r, t) → /api/available-watch-providers/${e}?region=${r}&genre=${t}
// But the API also needs "section" — it must be added by the server-side code

// Look for "section" in the context of available-watch-providers
const sectionContext = [...js.matchAll(/.{0,300}available-watch-providers.{0,300}/g)];
for (const m of sectionContext) {
  console.log(m[0].slice(0, 500));
  console.log();
}

// Look for the O() function that wraps fetch calls
const oFn = [...js.matchAll(/(?:const|var|function)\s+O\s*=\s*[^;]{5,300}/g)];
for (const m of oFn.slice(0, 2)) {
  console.log('O function:', m[0].slice(0, 300));
}

// Look for how fetch adds the "section" param
const sectionFetch = [...js.matchAll(/section[^;]{0,200}/gi)];
for (const m of [...new Set(sectionFetch.map(m => m[0]))].slice(0, 15)) {
  if (m.length > 10 && m.length < 200) console.log('  section:', m.slice(0, 150));
}
