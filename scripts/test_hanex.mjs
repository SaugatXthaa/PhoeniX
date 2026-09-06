import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://hanerix.com/e/idai5wak9cv0', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://pro.iqsmartgames.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});

// Find ALL script src
const jsFiles = [...r.body.matchAll(/src="([^"]*\.js[^"]*)"/g)];
console.log('JS files:');
for (const m of jsFiles) console.log('  ', m[1]);

// Find inline scripts
const scripts = [...r.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
console.log('\nInline scripts:', scripts.length);
for (let i = 0; i < scripts.length; i++) {
  const c = scripts[i][1].trim();
  if (c.length > 20) {
    console.log(`\n--- Script ${i} (${c.length} chars) ---`);
    console.log(c.slice(0, 1000));
  }
}

// Find API calls
console.log('\n=== API calls ===');
const apis = r.body.match(/\/api\/[a-z0-9/_?=${}.&-]+/gi);
if (apis) for (const a of [...new Set(apis)]) console.log('  ', a);

// Find fetch calls
const fetches = r.body.match(/fetch\([^)]+\)/g);
if (fetches) for (const f of fetches) console.log('  fetch:', f.slice(0, 200));

// Find data attributes
const dataAttrs = r.body.match(/data-[a-z]+="[^"]+"/gi);
if (dataAttrs) for (const d of [...new Set(dataAttrs)].slice(0, 10)) console.log('  ', d);
