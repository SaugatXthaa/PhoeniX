import { gotScraping } from 'got-scraping';

const imdbId = 'tt1375666';

// Test vs_src.php with different server parameters
for (let i = 1; i <= 9; i++) {
  const url = `https://proxy.garageband.rocks/vs_src.php?type=movie&id=${imdbId}&server=${i}`;
  const r = await gotScraping(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
    timeout: { request: 5000 }, throwHttpErrors: false,
  });
  if (r.statusCode === 200) {
    try {
      const data = JSON.parse(r.body);
      if (data.src) {
        const host = new URL(data.src).hostname;
        console.log(`Server ${i}: ${host} → ${data.src.slice(0, 80)}...`);
      } else {
        console.log(`Server ${i}: no src (${r.body.slice(0, 100)})`);
      }
    } catch {
      console.log(`Server ${i}: parse error (${r.body.slice(0, 100)})`);
    }
  } else {
    console.log(`Server ${i}: HTTP ${r.statusCode}`);
  }
}

// Also try without server param (default)
console.log('\n=== Default (no server param) ===');
const r = await gotScraping(`https://proxy.garageband.rocks/vs_src.php?type=movie&id=${imdbId}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 5000 }, throwHttpErrors: false,
});
const data = JSON.parse(r.body);
console.log('Default:', data.src?.slice(0, 100));

// Try the embed page directly and look for multiple server configs
console.log('\n=== Embed page servers ===');
const embedRes = await gotScraping(`https://proxy.garageband.rocks/embed/movie/${imdbId}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://www.imdbplay.tech/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Embed page size:', embedRes.body.length);

// Look for server configs in the embed page
const serverConfigs = [...embedRes.body.matchAll(/server[_-]?\d+[^,}]{0,200}/gi)];
console.log('Server configs:', serverConfigs.length);
for (const m of [...new Set(serverConfigs.map(m => m[0]))].slice(0, 5)) {
  console.log('  ', m.slice(0, 150));
}

// Look for ALL vs_src or data-api URLs
const apiUrls = [...embedRes.body.matchAll(/(?:vs_src\.php|data-api)[^"'\s<>]{0,200}/gi)];
console.log('\nAPI URLs in embed page:', apiUrls.length);
for (const m of [...new Set(apiUrls.map(m => m[0]))]) {
  console.log('  ', m.slice(0, 200));
}

// Look for ALL iframe data-api attributes
const dataApis = [...embedRes.body.matchAll(/data-api="([^"]+)"/gi)];
console.log('\ndata-api attributes:', dataApis.length);
for (const m of dataApis) {
  console.log('  ', m[1].slice(0, 200));
}
