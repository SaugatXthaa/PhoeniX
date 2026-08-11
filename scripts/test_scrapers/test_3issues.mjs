import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Test Pantyflix (animeshrine.xyz)
console.log('=== Pantyflix (animeshrine.xyz) ===');
try {
  const url = 'https://dl.animeshrine.xyz/dl/ce546e0bfa2c4b71e14475d06a7b9e878d6346b35550900ce3fdbf823868326c/video.mkv';
  const r = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), Range: 'bytes=0-1023' },
    timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: true,
  });
  console.log('Status:', r.statusCode, '| CT:', r.headers['content-type'], '| len:', r.body?.length || 0);
} catch (e) { console.log('ERR:', e.message.slice(0, 100)); }

// Test HiAnime (aniwatchtv.uk) with Referer
console.log('\n=== HiAnime (aniwatchtv.uk) with Referer ===');
try {
  const url2 = 'https://hls2.aniwatchtv.uk/v/scxqicy/4a0xe95o0l/ztouy1wmii/mfnev0gssf0eqm/master.m3u8';
  const r2 = await gotScraping.get(url2, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), Referer: 'https://zokoanime.video/' },
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  console.log('Status:', r2.statusCode, '| CT:', r2.headers['content-type'], '| body:', r2.body?.slice(0, 100));
} catch (e) { console.log('ERR:', e.message.slice(0, 100)); }

// Test HiAnime without Referer
console.log('\n=== HiAnime without Referer ===');
try {
  const r3 = await gotScraping.get('https://hls2.aniwatchtv.uk/v/scxqicy/4a0xe95o0l/ztouy1wmii/mfnev0gssf0eqm/master.m3u8', {
    headers: { ...hg.getHeaders({ httpVersion: '2' }) },
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  console.log('Status:', r3.statusCode, '| CT:', r3.headers['content-type'], '| body:', r3.body?.slice(0, 100));
} catch (e) { console.log('ERR:', e.message.slice(0, 100)); }

// Test AniVault
console.log('\n=== AniVault ===');
// Check what AniVault returns for Jujutsu Kaisen
try {
  const r4 = await gotScraping.get('https://phoenix-hgs3.onrender.com/stream/series/tmdb:95479:1:1.json', {
    timeout: { request: 60000 }, throwHttpErrors: false,
  });
  const d = JSON.parse(r4.body);
  const av = d.streams.filter(s => 'AniVault' in (s.name || '') || 'AniVault' in (s.title || ''));
  console.log('AniVault streams:', av.length);
  for (const s of av.slice(0, 3)) {
    console.log('  name:', s.name?.slice(0, 60));
    console.log('  title:', s.title?.split('\n')[0]?.slice(0, 80));
    console.log('  url:', s.url?.slice(0, 80));
    console.log();
  }
} catch (e) { console.log('ERR:', e.message.slice(0, 100)); }
