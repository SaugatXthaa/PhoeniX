// Verify stream URLs are playable (HEAD request + Range support check)
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

// Test URLs from the previous response
const URLS = [
  // 1icarus (direct MP4)
  'https://steep-sky-b7c6.icarus039.workers.dev/?data=T4A7ReSPWVQJFGq8V99vE6mQy7CCWXIE3IyVzRrUN1kkeMNo9vNOEOLAX1zS27biIASHB7GfAuqBBLMV05jxMmTfIae8d0oQFTT_ZgD0G84H_sQrVKY2yJMhSL8fapzfT4xAYz5aZGdrYiL_spRq_LkpAtfPu8muSukR2cuKqKpTAAWYEeb3S2JLiEhvi9r_lS7cxSeN84QVp_oPA1ww',
  // 1berkas (HLS)
  'https://berkas.test064-123.workers.dev/?data=VrRIajbNW7I56nFn7s-ibC72qO_81GuE56yxW3X3Ac6H2GKUDXpcfek6Kpojl-sk4HYWmu4hyRYLmrqnTOatOI3_HhyDaTX5iXGiev2m8TAJwuYniDAvgfy0mOtqsxPlvAWs_ofQhT7E-UtmsvRLhL9XPm3W0Xar9Qh5m57YwVz4GobWkbb5x5qWYJvI2bdYCTzTTrem26_UGC_7j5BE6-L3rHQChGfA0WfKz6M9U9NU5IILWOt-KTvQF2uce57leI5WrzqUeQjgrXRb29NhduCRYri-TvLhG4tNo7JsQBSn_I8rQv8xf4p9qjDR3LVrUCb5MP0FwI1TZLDlivDK3VLKEs3nOhZVrI6g4gtg_Wc2EWJ3fYNWQkMdjPX6CThnQHseYTFeyZjPIZ4k0MleWEeNx8CytF9zH6zT5VY3kf4moVgOzj50vN_Bd_xZOuqjBrtPW7qXw9qJLCUVuJUxzwUp0SAxVhJzAAL2f_r5i6EOw3sMpCvH5nOVoxVzW49Lm8XrVR_qgJbT601btMLB_HVC0FrN_q2sJICrXfPnzbcQh8cOMo_Cxps1EsVHbK_xCSp9fgF9GJCeAmGaQrBMH3adzEnzUSPCgv2SQ9bavkNvt9-FA',
  // 1athena (HLS)
  'https://daedalus.test45-b77.workers.dev/hls/s2/serial/tt0903747/1/1/playlist.m3u8?tok=DfG3tqW8yuHcEtAzFH9FXS-S-eGojF2vEZLniv6vmeE&exp=1786400127908',
  // 1sentinel (m3u8 with subs)
  'https://aapanel.devcorp.me/assets/18974469-4c67-561f-b236-91bce221556c.m3u8',
];

for (const url of URLS) {
  console.log(`\n=== ${url.slice(0, 80)}... ===`);
  // Try HEAD first
  try {
    const headRes = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`HEAD: ${headRes.statusCode}`);
    console.log(`  CT: ${headRes.headers['content-type']}`);
    console.log(`  CL: ${headRes.headers['content-length']}`);
    console.log(`  ACC-RANGES: ${headRes.headers['accept-ranges']}`);
  } catch (e) {
    console.log(`HEAD ERR: ${e.message}`);
  }

  // Try GET with Range header
  try {
    const getRes = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), Range: 'bytes=0-1023' },
      timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`GET (Range 0-1023): ${getRes.statusCode}`);
    console.log(`  CT: ${getRes.headers['content-type']}`);
    console.log(`  CR: ${getRes.headers['content-range']}`);
    console.log(`  Body len: ${getRes.body.length}`);
    if (getRes.statusCode === 200 || getRes.statusCode === 206) {
      console.log(`  First 200 chars: ${getRes.body.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`GET ERR: ${e.message}`);
  }
}
