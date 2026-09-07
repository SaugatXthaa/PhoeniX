// Analyze imdbplay.tech movie page for stream data
import { gotScraping } from 'got-scraping';
import fs from 'fs';

const r = await gotScraping('https://www.imdbplay.tech/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const html = r.body;
fs.writeFileSync('/tmp/ip_movie3.html', html);
console.log('Status:', r.statusCode, '| size:', html.length);

// Look for JSON data blocks
const jsonBlocks = html.match(/\{[^{}]*(?:server|source|stream|quality|video|player|embed|url)[^{}]*\}/gi);
console.log('\nJSON blocks with stream keywords:', jsonBlocks?.length || 0);
if (jsonBlocks) for (const b of jsonBlocks.slice(0, 5)) console.log('  ', b.slice(0, 200));

// Look for script type=application/json
const scripts = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)];
console.log('\nJSON scripts:', scripts.length);
for (const s of scripts.slice(0, 2)) console.log('  ', s[1].slice(0, 300));

// Look for stream/video URLs
const streamUrls = html.match(/https?:\/\/[^"'<>\s]+(?:m3u8|mp4|mkv|stream|video|player|embed)[^"'<>\s]*/gi);
console.log('\nStream URLs:', streamUrls?.length || 0);
if (streamUrls) for (const u of [...new Set(streamUrls)].slice(0, 5)) console.log('  ', u.slice(0, 150));

// Look for server names / quality labels
const serverStrings = [...html.matchAll(/["'`]([^"'`]{5,50}(?:server|source|quality|stream|1080|720|480|2160|4k)[^"'`]{0,30})["'`]/gi)];
console.log('\nServer/quality strings:', serverStrings.length);
for (const m of [...new Set(serverStrings.map(m => m[1]))].slice(0, 10)) console.log('  ', m);

// Look for self.__next_f or similar data
const nextData = html.match(/self\.__next_f[^<]{0,500}/);
if (nextData) console.log('\nNext data:', nextData[0].slice(0, 200));

// Look for any API responses embedded in the page
const apiData = html.match(/(?:sources|servers|streams|playbackUrl|videoUrl|streamUrl)["'\s:=]+([^,}"'\s]{5,100})/gi);
console.log('\nAPI data patterns:', apiData?.length || 0);
if (apiData) for (const m of apiData.slice(0, 5)) console.log('  ', m.slice(0, 150));

// Dump ALL unique external URLs
const allUrls = [...html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]+)\/[a-z0-9/_?=&.-]+/gi)];
const hosts = new Set();
for (const m of allUrls) hosts.add(m[1]);
console.log('\nAll external hosts:', [...hosts].sort());
