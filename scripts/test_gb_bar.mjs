import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://proxy.garageband.rocks/embed/movie/tt15239678', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://www.imdbplay.tech/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Look for the vs-bar (server bar) and server switching logic
const vsBar = r.body.match(/vs-bar[\s\S]{0,3000}/);
if (vsBar) {
  console.log('vs-bar found!');
  console.log(vsBar[0].slice(0, 1000));
}

// Look for server switching in the inline scripts
const scripts = [...r.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
for (let i = 0; i < scripts.length; i++) {
  const c = scripts[i][1].trim();
  if (c.includes('server') || c.includes('Server') || c.includes('source') || c.includes('Source')) {
    console.log(`\n=== Script ${i} (${c.length} chars, has server/source) ===`);
    // Find server-related code
    const serverCode = c.match(/(?:server|source|quality|4k|1080|720)[^;]{0,200}/gi);
    if (serverCode) {
      for (const s of [...new Set(serverCode)].slice(0, 10)) {
        console.log('  ', s.slice(0, 150));
      }
    }
  }
}

// Look for the data-api with server param
const dataApis = [...r.body.matchAll(/data-api="([^"]+)"/gi)];
console.log('\ndata-api attributes:');
for (const m of dataApis) console.log('  ', m[1]);

// Look for vs_src.php with server param
const vsSrc = [...r.body.matchAll(/vs_src\.php[^"'\s<>]*/gi)];
console.log('\nvs_src.php references:');
for (const m of [...new Set(vsSrc.map(m => m[0]))]) console.log('  ', m);
