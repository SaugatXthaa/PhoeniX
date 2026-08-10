// Direct fetch of the zxcstream.xyz player iframe URL
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import fs from 'fs';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

const URLS = [
  'https://zxcstream.xyz/player/movie/155?server=0&subLang=english',
  'https://zxcstream.xyz/player/movie/155?server=1&subLang=english',
  'https://zxcstream.xyz/player/movie/155?server=2&subLang=english',
  'https://zxcstream.xyz/player/tv/1396/1/1?server=0&subLang=english',
  'https://zxcstream.xyz/embed/movie/155',
  'https://zxcstream.xyz/embed/tv/1396/1/1',
  'https://zxcstream.xyz/',
  'https://zxcstream.xyz/api/movie/155',
  'https://zxcstream.xyz/api/tv/1396/1/1',
  'https://zxcstream.xyz/backend/token',
  'https://zxcstream.xyz/backend_/embed/sentinel',
];

for (const u of URLS) {
  console.log(`\n=== ${u} ===`);
  try {
    const res = await gotScraping.get(u, {
      headers: {
        ...hg.getHeaders({ httpVersion: '2' }),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: { request: 15000 },
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: 5,
      http2: true,
    });
    console.log(`Status: ${res.statusCode}`);
    console.log(`Final URL: ${res.url}`);
    console.log(`Body len: ${res.body.length}`);
    if (res.statusCode === 200) {
      console.log(`First 1500 chars:\n${res.body.slice(0, 1500)}`);
      const safe = u.replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
      fs.writeFileSync(`/home/z/my-project/scripts/test_zxc/resp_${safe}.html`, res.body);
    }
  } catch (e) {
    console.log(`ERR: ${e.message}`);
  }
}
