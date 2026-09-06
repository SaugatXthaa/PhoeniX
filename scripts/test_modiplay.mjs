import { gotScraping } from 'got-scraping';

// Server 1 embed URL
const url = 'https://rozgarlelo.modiplay.xyz/embed/imdb/movie?id=tt32820897';
const r = await gotScraping(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://multimovies.beer/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// We already found it has minochinos.com and multimoviesshg.com embeds
// But let me check if it ALSO has direct stream URLs or an API
const m3u8 = r.body.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi);
const mp4 = r.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
console.log('m3u8:', m3u8?.length || 0);
console.log('mp4:', mp4?.length || 0);

// Find ALL URLs
const allUrls = r.body.match(/https?:\/\/[a-z0-9.-]+\.[a-z]+\/[a-z0-9/_?=&.-]+/gi);
if (allUrls) {
  console.log('\nAll URLs:');
  for (const u of [...new Set(allUrls)]) console.log('  ', u.slice(0, 150));
}

// Find JS variables
const vars = r.body.match(/(?:let|var|const)\s+\w+\s*=\s*[^;]+;/g);
if (vars) {
  console.log('\nJS variables:');
  for (const v of vars.slice(0, 15)) console.log('  ', v.slice(0, 150));
}
