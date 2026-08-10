// Check the m3u8 playlist for multiple audio tracks (Japanese, English, etc.)
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

const url = 'https://cache.libria.fun/videos/media/ts/8789/1/1080/93729431f273cc2c1b7891965a3deda6.m3u8?countryIso=HK&isAuthorized=0&isWithVideoAds=1&isWithVideoAdsAlways=1';

const r = await gotScraping.get(url, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});

console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']}`);
console.log(`Body length: ${r.body.length}`);
console.log('\n=== Full m3u8 content ===');
console.log(r.body);
