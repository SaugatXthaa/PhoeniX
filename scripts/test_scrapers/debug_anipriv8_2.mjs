// Test what happens when AniPriv8 stream URL is requested via the addon
// Simulate what Stremio would do: GET the m3u8, parse it, fetch a segment
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
const API_BASE = 'https://anipriv8.online';

// 1. Fetch the m3u8 playlist
const playlistUrl = 'https://anipriv8.online/api/secure/pipeline/9deF5ckzgp436CnsYh-UrUHo';
console.log('=== Fetch m3u8 playlist ===');
const r = await gotScraping.get(playlistUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']}`);
console.log(`Body (first 800):\n${r.body.slice(0, 800)}`);

// 2. Extract first segment URL and try to fetch it
const lines = r.body.split('\n').filter(l => l.trim() && !l.startsWith('#'));
const firstSegment = lines[0]?.trim();
console.log(`\n=== First segment: ${firstSegment} ===`);

// Resolve relative URL
const segAbs = new URL(firstSegment, playlistUrl).href;
console.log(`Absolute: ${segAbs}`);

const segRes = await gotScraping.get(segAbs, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*', 'Range': 'bytes=0-1023' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log(`Status: ${segRes.statusCode} | CT: ${segRes.headers['content-type']} | CL: ${segRes.headers['content-length']} | CR: ${segRes.headers['content-range']}`);
console.log(`Body len: ${segRes.body?.length || 0}`);
if (segRes.statusCode === 200 || segRes.statusCode === 206) {
  const head = segRes.body.slice(0, 16);
  console.log(`First 16 bytes (hex): ${Buffer.from(head).toString('hex')}`);
  // MPEG-TS starts with 0x47 sync byte
  console.log(`Is MPEG-TS: ${head[0] === 0x47}`);
}

// 3. Check CORS headers on the m3u8 response
console.log(`\n=== CORS check on m3u8 ===`);
const corsRes = await gotScraping.head(playlistUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Origin': 'https://app.stremio.com' },
  timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: true,
});
console.log(`Status: ${corsRes.statusCode}`);
console.log(`Headers:`);
for (const [k, v] of Object.entries(corsRes.headers)) {
  if (k.toLowerCase().startsWith('access-control') || k.toLowerCase() === 'vary') {
    console.log(`  ${k}: ${v}`);
  }
}
