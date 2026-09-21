// Task 72: check vidking.net player bundle for API base rotation
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function get(url, extra = {}) {
  const r = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, ...extra },
    timeout: { request: 25000 }, throwHttpErrors: false, http2: false,
    responseType: 'buffer',
  });
  return r;
}

// 1. vidking player page for a movie
const page = await get('https://www.vidking.net/movie/tt15239678');
console.log(`vidking page: ${page.statusCode} ${page.body.length}B`);
const html = page.body.toString();
const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(m => m[1]);
console.log('scripts:', scripts.slice(0, 8).join('\n  '));

// 2. every domain mentioned on the page
const domains = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1]))];
console.log('page domains:', domains.join(', '));

// 3. fetch the main player bundle(s) and grep API bases
for (const s of scripts.slice(0, 4)) {
  const url = s.startsWith('http') ? s : `https://www.vidking.net${s}`;
  try {
    const b = await get(url);
    const body = b.body.toString();
    const apiDomains = [...new Set([...body.matchAll(/https?:\\?\/\\?\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1]))]
      .filter(d => !/w3\.org|schema|google|fonts|gstatic|cloudflare|jsdelivr|unpkg|sentry|youtube/.test(d));
    console.log(`\nbundle ${url.slice(-60)}: ${b.statusCode} ${b.body.length}B`);
    console.log('  api-ish domains:', apiDomains.slice(0, 25).join(', '));
    const srl = [...new Set([...body.matchAll(/[a-z0-9-]*speedracelight[a-z0-9.-]*/gi)].map(m => m[0]))];
    if (srl.length) console.log('  speedracelight refs:', srl.join(', '));
    // look for the /seed endpoint pattern
    const seedRefs = [...body.matchAll(/["'`](\/[a-z]+\/seed|\/seed\?[^"'`]{0,40})["'`]/g)].map(m => m[0]);
    if (seedRefs.length) console.log('  seed refs:', [...new Set(seedRefs)].slice(0, 6).join(' | '));
  } catch (e) { console.log(`bundle ${url}: ERR ${e.message}`); }
}
