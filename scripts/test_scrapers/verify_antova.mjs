// Verify Antova stream URLs are playable
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

const URLS = [
  'https://cache.libria.fun/videos/media/ts/10278/1/1080/b4e23d61127b8c48841ed17425',
  'https://cache.libria.fun/videos/media/ts/10278/1/720/7b70351c5e67fb2255327fb305e',
  'https://cache.libria.fun/videos/media/ts/10278/1/480/b30afe16b099eb503fe31a67f0d',
];

for (const url of URLS) {
  console.log(`\n--- ${url.slice(-60)} ---`);
  try {
    // Try direct GET
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
      timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body.length}`);
    if (r.statusCode === 200) {
      console.log(`First 200 chars: ${r.body.slice(0, 200)}`);
    } else if (r.statusCode === 403 || r.statusCode === 401) {
      console.log(`Auth required? Body: ${r.body.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`ERR: ${e.message}`);
  }
}
