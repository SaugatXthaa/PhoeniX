// Probe the three ZXC sites to understand their API patterns.
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SITES = [
  { name: 'zxcstream.icu', url: 'https://www.zxcstream.icu/?m=1' },
  { name: 'zxcprime.icu',  url: 'https://zxcprime.icu/' },
  { name: 'player.zxcprime.xyz', url: 'https://player.zxcprime.xyz/' },
];

for (const site of SITES) {
  console.log('\n========================================');
  console.log(`PROBING: ${site.name} → ${site.url}`);
  console.log('========================================');
  try {
    const res = await gotScraping.get(site.url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: { request: 20000 },
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: 5,
    });
    console.log(`Status: ${res.statusCode}`);
    console.log(`Final URL: ${res.url}`);
    console.log(`Body length: ${res.body.length}`);
    console.log('--- First 3000 chars ---');
    console.log(res.body.slice(0, 3000));
    console.log('--- Last 2000 chars ---');
    console.log(res.body.slice(-2000));
  } catch (e) {
    console.log(`Error: ${e.message}`);
    if (e.response) {
      console.log(`Status: ${e.response.statusCode}`);
      console.log(`Body: ${(e.response.body || '').slice(0, 1000)}`);
    }
  }
}
