// Test if got-scraping can resolve fastdlserver URLs (instead of curl)
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const BASE = 'https://pantyflix.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Test URL: fastdlserver URL from Dune Part Two
const fastDlUrl = 'https://dl.fastdlserver.site/?id=K053YkEvZmNYUjArN1doV3RoWE1icGFkekxiYldkeWJNZWFScmxkUFdZZ2hvak9xdVl';

console.log('=== Step 1: Fetch fastdlserver page ===');
let r = await gotScraping.get(fastDlUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html', 'Referer': `${BASE}/` },
  timeout: { request: 12000 }, throwHttpErrors: false, followRedirect: true, maxRedirects: 10,
});
console.log(`Status: ${r.statusCode} | Final URL: ${r.url?.slice(0, 80)} | Body len: ${r.body?.length || 0}`);

// Look for /cflare/ link
const cflareMatch = r.body?.match(/href="(\/cflare\/[^"]+)"/);
if (cflareMatch) {
  const cflareUrl = `https://new3.gdflix.io${cflareMatch[1]}`;
  console.log(`\n=== Step 2: Fetch cflare page: ${cflareUrl.slice(0, 80)} ===`);
  r = await gotScraping.get(cflareUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html', 'Referer': 'https://new3.gdflix.io/' },
    timeout: { request: 12000 }, throwHttpErrors: false, followRedirect: true, maxRedirects: 10,
  });
  console.log(`Status: ${r.statusCode} | Body len: ${r.body?.length || 0}`);

  // Extract direct URL
  const cloudDlMatch = r.body?.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
  if (cloudDlMatch) {
    const directUrl = cloudDlMatch[0];
    console.log(`\nDirect URL: ${directUrl.slice(0, 100)}`);

    // Test playability
    console.log('\n=== Step 3: Test direct URL ===');
    const testR = await gotScraping.get(directUrl, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), Range: 'bytes=0-1023' },
      timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`Status: ${testR.statusCode} | CT: ${testR.headers['content-type']} | Body len: ${testR.body?.length || 0}`);
  } else {
    console.log('No cloud-dl URL found');
    // Try busycdn
    const busyMatch = r.body?.match(/https:\/\/instant\.busycdn\.xyz[^"'\s<>]+/i);
    if (busyMatch) console.log(`Busycdn: ${busyMatch[0].slice(0, 100)}`);
  }
} else {
  console.log('No /cflare/ link found');
  // Try direct cloud-dl URL
  const directMatch = r.body?.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
  if (directMatch) console.log(`Direct cloud-dl: ${directMatch[0].slice(0, 100)}`);
}
