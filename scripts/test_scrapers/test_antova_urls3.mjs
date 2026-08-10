// Try URL variations for Antova streams - using GET with timeout
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

const url = 'https://cache.libria.fun/videos/media/ts/10278/1/1080/b4e23d61127b8c48841ed17425';

const variations = [
  url,
  url + '.m3u8',
  url + '/playlist.m3u8',
  url + '.m3u8?countryIso=US&isAuthorized=0',
];

console.log('Starting tests...');

for (const v of variations) {
  console.log(`Testing: ${v.slice(60)}`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await gotScraping.get(v, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 8000 },
      throwHttpErrors: false,
      http2: true,
      followRedirect: true,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log(`  → ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body?.length || 0}`);
    if (r.statusCode === 200) console.log(`  First 100: ${r.body.slice(0, 100)}`);
  } catch (e) {
    console.log(`  → ERR: ${e.message}`);
  }
}
console.log('Done.');
