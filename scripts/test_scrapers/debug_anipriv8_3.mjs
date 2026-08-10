// Investigate the AniPriv8 segment corruption — body looks like UTF-8 mangled
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import fs from 'fs';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

const segUrl = 'https://anipriv8.online/api/secure/pipeline/55RRvFgscHS1WQHk79SHzU4c';
console.log('=== Fetch segment with binary mode ===');

// got-scraping returns body as string by default — we need to set responseType
// to 'buffer' to get the raw bytes
const r = await gotScraping(segUrl, {
  method: 'GET',
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*', 'Range': 'bytes=0-1023' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  responseType: 'buffer',
});
console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']} | CR: ${r.headers['content-range']}`);
console.log(`Body type: ${typeof r.body} | isBuffer: ${Buffer.isBuffer(r.body)}`);
console.log(`Body len: ${r.body?.length || 0}`);

if (Buffer.isBuffer(r.body)) {
  const head = r.body.slice(0, 32);
  console.log(`First 32 bytes (hex): ${head.toString('hex')}`);
  console.log(`First byte: 0x${head[0].toString(16)} (MPEG-TS sync byte is 0x47)`);
  console.log(`Is MPEG-TS: ${head[0] === 0x47}`);
  // Count 0x47 sync bytes at every 188-byte offset
  let syncCount = 0;
  for (let i = 0; i < r.body.length; i += 188) {
    if (r.body[i] === 0x47) syncCount++;
  }
  console.log(`Sync bytes at 188-byte offsets: ${syncCount} / ${Math.floor(r.body.length / 188)}`);
}

// Try without Range header
console.log('\n=== Fetch without Range ===');
const r2 = await gotScraping(segUrl, {
  method: 'GET',
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  responseType: 'buffer',
});
console.log(`Status: ${r2.statusCode} | CT: ${r2.headers['content-type']} | CL: ${r2.headers['content-length']}`);
if (Buffer.isBuffer(r2.body)) {
  const head = r2.body.slice(0, 32);
  console.log(`First 32 bytes (hex): ${head.toString('hex')}`);
  console.log(`First byte: 0x${head[0].toString(16)}`);
  let syncCount = 0;
  for (let i = 0; i < Math.min(r2.body.length, 10000); i += 188) {
    if (r2.body[i] === 0x47) syncCount++;
  }
  console.log(`Sync bytes at 188-byte offsets (first 10k): ${syncCount} / ${Math.floor(Math.min(r2.body.length, 10000) / 188)}`);
  // Save first 4KB to file for inspection
  fs.writeFileSync('/tmp/anipriv8_seg.bin', r2.body.slice(0, 4096));
  console.log('Saved first 4KB to /tmp/anipriv8_seg.bin');
}
