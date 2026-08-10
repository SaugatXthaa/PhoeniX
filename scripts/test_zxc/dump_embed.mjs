// Dump the full embed page to understand the stream loading mechanism
import { gotScraping } from 'got-scraping';
import fs from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const url = 'https://player.zxcprime.xyz/embed/movie/155';
const res = await gotScraping.get(url, {
  headers: {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  timeout: { request: 20000 },
  throwHttpErrors: false,
  followRedirect: true,
});

fs.writeFileSync('/home/z/my-project/scripts/test_zxc/embed_movie_155.html', res.body);
console.log('Saved. Length:', res.body.length);

// Look for key markers (escape regex specials)
const markers = [
  'm3u8', 'mp4', 'stream', 'playback', 'source', 'videoUrl', 'file', 'video',
  'api\\.', '/api', 'fetch\\(', 'getServerSideProps', '__next_f', '__NEXT_DATA__',
  'hls', 'src=', 'data-', 'json', 'POST', 'GET', 'credentials',
  'vidsrc', 'vidlink', 'vidfast', 'vidking', 'vixsrc', 'two-dhive', 'mega',
  'googleusercontent', 'gdrive', 'workers\\.dev', 'r2\\.dev', 'cloudfront',
  'tmdb', 'imdb', 'episode', 'season',
];

for (const m of markers) {
  const re = new RegExp(m, 'gi');
  const matches = [...res.body.matchAll(re)];
  if (matches.length > 0) {
    console.log(`"${m.replace(/\\/g,'')}": ${matches.length} matches`);
  }
}

// Also test the TV embed pattern
console.log('\n--- Testing TV embed ---');
const tvUrl = 'https://player.zxcprime.xyz/embed/tv/1396/1/1';
const tvRes = await gotScraping.get(tvUrl, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 20000 }, throwHttpErrors: false, followRedirect: true,
});
fs.writeFileSync('/home/z/my-project/scripts/test_zxc/embed_tv_1396_1_1.html', tvRes.body);
console.log('TV embed status:', tvRes.statusCode, 'len:', tvRes.body.length);
