// Download and analyze the injusticebakery.com challenge script
import { gotScraping } from 'got-scraping';
import fs from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SCRIPTS = [
  'https://injusticebakery.com/13/0a/d5/130ad559daaa237711442437661b86a6.js',
  'https://injusticebakery.com/5c/15/e7/5c15e7185944758aafe9b32aa87f5279.js',
];

for (const url of SCRIPTS) {
  console.log(`\n=== ${url} ===`);
  try {
    const res = await gotScraping.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Referer': 'https://player.zxcprime.xyz/',
      },
      timeout: { request: 15000 }, throwHttpErrors: false,
    });
    console.log(`Status: ${res.statusCode}, len: ${res.body.length}`);
    if (res.statusCode === 200) {
      const safe = url.split('/').slice(-2).join('_').replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(`/home/z/my-project/scripts/test_zxc/injustice_${safe}`, res.body);
      console.log(`Saved. First 2000 chars:`);
      console.log(res.body.slice(0, 2000));
      console.log('--- Last 1000 chars ---');
      console.log(res.body.slice(-1000));
    }
  } catch (e) { console.log(`Err: ${e.message}`); }
}
