// Download and analyze the page-specific JS chunks to find API endpoints
import { gotScraping } from 'got-scraping';
import fs from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://player.zxcprime.xyz';

const CHUNKS = [
  '/_next/static/chunks/101r9kj-v9of4.js',
  '/_next/static/chunks/0kv-jqe0ak1n7.js',
  '/_next/static/chunks/0kds9z5xjwk_6.js',
  '/_next/static/chunks/17swzel-tzom..js',
  '/_next/static/chunks/0n9ecy-ukmyc0.js',
  '/_next/static/chunks/00-csyj9a6t-x.js',
];

for (const c of CHUNKS) {
  const url = `${BASE}${c}`;
  console.log(`\n--- ${c}`);
  try {
    const res = await gotScraping.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': `${BASE}/embed/movie/155` },
      timeout: { request: 20000 }, throwHttpErrors: false,
    });
    console.log(`Status: ${res.statusCode}, len: ${res.body.length}`);
    if (res.statusCode === 200) {
      const safe = c.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(`/home/z/my-project/scripts/test_zxc/chunk_${safe}`, res.body);

      // Search for API endpoints and stream patterns
      const patterns = [
        /api\/[a-zA-Z0-9_\-\/]+/g,
        /https?:\/\/[a-zA-Z0-9.\-]+\.[a-z]{2,}[/a-zA-Z0-9._\-]*/g,
        /\.m3u8/g,
        /m3u8|mp4|mkv|hls|stream|playback|sources?|videoUrl|fileUrl/gi,
        /fetch\s*\([^)]+\)/g,
        /\bendpoint\b/gi,
        /\bserver\b/gi,
        /tmdb|imdb|mal|anilist|kitsu/gi,
        /vidsrc|vidlink|vidfast|vidking|vixsrc|2embed|multiembed|gdrive/gi,
        /[\w-]+\.(?:workers\.dev|r2\.dev|pages\.dev|vercel\.app|onrender\.com|fly\.dev)/g,
      ];
      const found = new Set();
      for (const p of patterns) {
        const m = res.body.match(p);
        if (m) m.slice(0, 30).forEach(x => found.add(x));
      }
      console.log(`Found ${found.size} candidate strings:`);
      for (const f of [...found].slice(0, 80)) console.log('  ', f);
    }
  } catch (e) {
    console.log(`Err: ${e.message}`);
  }
}
