// Get fresh stream URLs and immediately verify playback
import { ZXCStream } from '/home/z/my-project/src/source/ZXCStream.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const src = new ZXCStream({});
const ctx = { config: { multi: true }, hostUrl: 'https://test' };

console.log('Getting fresh streams for The Dark Knight...');
const streams = await src.handleInternal(ctx, 'movie', { id: 155, type: 'movie' });
console.log(`Got ${streams.length} streams. Testing first 5...\n`);

for (const s of streams.slice(0, 5)) {
  console.log(`--- ${s.meta.title} ---`);
  console.log(`  URL: ${s.url.href.slice(0, 100)}...`);
  try {
    const r = await gotScraping.get(s.url.href, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), Range: 'bytes=0-1023' },
      timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`  Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body.length}`);
    if (r.statusCode === 200 || r.statusCode === 206) {
      // Check if it's a valid video file (MP4 starts with ftyp, HLS starts with #EXTM3U)
      const head = r.body.slice(0, 8).toString('latin1');
      if (head.includes('ftyp')) console.log('  → Valid MP4 file ✓');
      else if (head.includes('#EXTM3U')) console.log('  → Valid HLS playlist ✓');
      else console.log('  → First 8 chars:', head);
    } else if (r.statusCode === 403) {
      console.log('  → 403:', r.body.slice(0, 100));
    }
  } catch (e) {
    console.log(`  ERR: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n\nGetting fresh streams for Jujutsu Kaisen DUB...');
const streams2 = await src.handleInternal(ctx, 'series', { id: 95479, type: 'series', season: 1, episode: 1 });
const dubStreams = streams2.filter(s => s.meta.title.includes('(DUB'));
console.log(`Got ${dubStreams.length} DUB streams. Testing first 2...\n`);

for (const s of dubStreams.slice(0, 2)) {
  console.log(`--- ${s.meta.title} ---`);
  console.log(`  URL: ${s.url.href.slice(0, 100)}...`);
  try {
    const r = await gotScraping.get(s.url.href, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), Range: 'bytes=0-1023' },
      timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`  Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body.length}`);
    if (r.statusCode === 200 || r.statusCode === 206) {
      const head = r.body.slice(0, 8).toString('latin1');
      if (head.includes('ftyp')) console.log('  → Valid MP4 file ✓');
      else if (head.includes('#EXTM3U')) console.log('  → Valid HLS playlist ✓');
      else console.log('  → First 8 chars:', head);
    } else if (r.statusCode === 403) {
      console.log('  → 403:', r.body.slice(0, 100));
    }
  } catch (e) {
    console.log(`  ERR: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 500));
}
