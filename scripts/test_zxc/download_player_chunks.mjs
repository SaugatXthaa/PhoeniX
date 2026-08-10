// Download and analyze /player/ route chunks
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import fs from 'fs';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
const BASE = 'https://player.zxcstream.xyz';

// First, get the player page to find its specific chunks
const playerPage = await gotScraping.get(`${BASE}/player/movie/155?server=0&subLang=english`, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
fs.writeFileSync('/home/z/my-project/scripts/test_zxc/player_page.html', playerPage.body);
console.log(`Player page len: ${playerPage.body.length}`);

// Extract chunk URLs from the HTML
const chunkUrls = [...playerPage.body.matchAll(/\/_next\/static\/chunks\/[^\s"']+\.js/g)].map(m => m[0]);
console.log(`Found ${chunkUrls.length} chunks:`);
const unique = [...new Set(chunkUrls)];
for (const c of unique) console.log(`  ${c}`);

// Download each chunk
for (const c of unique) {
  if (c.includes('turbopack') || c.includes('0ygj8fwxuy_8e') || c.includes('0qg~ek2lno78c') ||
      c.includes('0d7nuaqfu0491') || c.includes('152k2ttyoaood') || c.includes('0n9ecy-ukmyc0') ||
      c.includes('00-csyj9a6t-x') || c.includes('0-4oo_oi06i0r')) {
    console.log(`\n--- SKIP (shared chunk): ${c}`);
    continue;
  }
  console.log(`\n--- Downloading: ${c}`);
  const url = `${BASE}${c}`;
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*', 'Referer': `${BASE}/player/movie/155` },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Status: ${res.statusCode}, len: ${res.body.length}`);
  if (res.statusCode === 200) {
    const safe = c.split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');
    fs.writeFileSync(`/home/z/my-project/scripts/test_zxc/player_chunk_${safe}`, res.body);

    // Look for API endpoints and stream patterns
    const patterns = [
      /\/backend[a-zA-Z0-9_\-\/]*/g,
      /\/api\/[a-zA-Z0-9_\-\/]+/g,
      /https?:\/\/[a-zA-Z0-9.\-]+\.[a-z]{2,}[/a-zA-Z0-9._\-]*/g,
      /\.m3u8/g,
      /fetch\s*\([^)]+\)/g,
      /tmdb|imdb|mal|anilist|kitsu/gi,
      /vidsrc|vidlink|vidfast|vidking|vixsrc|2embed|multiembed|gdrive/gi,
      /[\w-]+\.(?:workers\.dev|r2\.dev|pages\.dev|vercel\.app|onrender\.com|fly\.dev)/g,
      /\bserver\b|\bsources?\b|\bstreamUrl\b|\bvideoUrl\b|\bplaybackUrl\b/gi,
    ];
    const found = new Set();
    for (const p of patterns) {
      const m = res.body.match(p);
      if (m) m.slice(0, 50).forEach(x => found.add(x));
    }
    if (found.size > 0) {
      console.log(`Found ${found.size} candidates:`);
      for (const f of [...found].slice(0, 60)) console.log(`  ${f}`);
    }
  }
}
