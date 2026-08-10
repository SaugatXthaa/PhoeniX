// Find the correct Referer for the workers.dev stream URLs
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

const URL = 'https://steep-sky-b7c6.icarus039.workers.dev/?data=T4A7ReSPWVQJFGq8V99vE6mQy7CCWXIE3IyVzRrUN1kkeMNo9vNOEOLAX1zS27biIASHB7GfAuqBBLMV05jxMmTfIae8d0oQFTT_ZgD0G84H_sQrVKY2yJMhSL8fapzfT4xAYz5aZGdrYiL_spRq_LkpAtfPu8muSukR2cuKqKpTAAWYEeb3S2JLiEhvi9r_lS7cxSeN84QVp_oPA1ww';

const REFERERS = [
  undefined,
  'https://player.zxcstream.xyz/',
  'https://zxcstream.xyz/',
  'https://www.zxcstream.icu/',
  'https://zxcstream.icu/',
  'https://player.zxcprime.xyz/',
  'https://zxcprime.icu/',
  'https://zxcprime.xyz/',
  'https://player.zxcstream.xyz/player/movie/155?server=1icarus&subLang=english',
  'https://zxcstream.xyz/player/movie/155?server=1icarus&subLang=english',
];

for (const ref of REFERERS) {
  console.log(`\n--- Referer: ${ref || '(none)'} ---`);
  try {
    const headers = { ...hg.getHeaders({ httpVersion: '2' }) };
    if (ref) headers['Referer'] = ref;
    const res = await gotScraping.get(URL, {
      headers,
      timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`Status: ${res.statusCode} | CT: ${res.headers['content-type']} | CL: ${res.headers['content-length']} | Body len: ${res.body.length}`);
    if (res.statusCode === 200 || res.statusCode === 206) {
      console.log(`First 200 chars: ${res.body.slice(0, 200)}`);
    } else if (res.statusCode === 403) {
      console.log(`Body: ${res.body.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`ERR: ${e.message}`);
  }
}
