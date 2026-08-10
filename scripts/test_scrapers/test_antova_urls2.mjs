// Try URL variations for Antova streams - simple version
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
console.log('Variations count:', variations.length);

for (let i = 0; i < variations.length; i++) {
  const v = variations[i];
  process.stdout.write(`[${i+1}/${variations.length}] Testing: ${v.slice(60)}... `);
  try {
    const r = await gotScraping.head(v, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`${r.statusCode} | CT: ${r.headers['content-type']}`);
  } catch (e) {
    console.log(`ERR: ${e.message}`);
  }
}
console.log('Done.');
