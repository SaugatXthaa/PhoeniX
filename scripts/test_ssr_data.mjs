import { gotScraping } from 'got-scraping';
import fs from 'fs';

const r = await gotScraping('https://www.imdbplay.tech/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const html = r.body;

// Find the SSR data blob (self.$R)
const ssrStart = html.indexOf('self.$R=self.$R');
if (ssrStart >= 0) {
  const ssrEnd = html.indexOf('</script>', ssrStart);
  const ssrData = html.substring(ssrStart, ssrEnd);
  fs.writeFileSync('/tmp/ip_ssr_data.txt', ssrData);
  console.log('SSR data length:', ssrData.length);
  
  // Search for ALL URLs in the SSR data
  const urls = [...ssrData.matchAll(/https?:\/\/[^"'\s,;<>]+/gi)];
  console.log('URLs in SSR data:', urls.length);
  for (const u of [...new Set(urls.map(m => m[0]))]) {
    if (!u.includes('google') && !u.includes('font') && !u.includes('cloudflare') && 
        !u.includes('imdbplay.tech/og') && !u.includes('imdbplay.tech/icon')) {
      console.log('  ', u.slice(0, 200));
    }
  }
  
  // Search for server-related data
  const serverData = ssrData.match(/server[^,;]{0,200}/gi);
  if (serverData) {
    console.log('\nServer references:', serverData.length);
    for (const s of [...new Set(serverData)].slice(0, 10)) {
      console.log('  ', s.slice(0, 150));
    }
  }
  
  // Search for embed/stream/provider URLs
  const embedData = ssrData.match(/(?:embed|stream|provider|source|garageband|vidsrc|cloud|proxy)[^,;]{0,100}/gi);
  if (embedData) {
    console.log('\nEmbed/stream references:', embedData.length);
    for (const s of [...new Set(embedData)].slice(0, 10)) {
      console.log('  ', s.slice(0, 150));
    }
  }
  
  // Look for the server function IDs
  const fnIds = [...ssrData.matchAll(/serverFnMeta:\s*\{id:\s*"([^"]+)"/gi)];
  console.log('\nServer function IDs:', fnIds.length);
  for (const m of fnIds) console.log('  ', m[1]);
  
  // Look for the actual server data (might be in the $R array)
  // The $R array contains all SSR data in order
  const arrayData = ssrData.match(/\$R\[(\d+)\]=([^,;]{5,500})/g);
  if (arrayData) {
    console.log('\n$R array entries:', arrayData.length);
    // Look for entries that contain server/embed/stream data
    for (const entry of arrayData) {
      if (/server|embed|stream|source|garageband|vidsrc|cloud|proxy|player/i.test(entry)) {
        console.log('  ', entry.slice(0, 200));
      }
    }
  }
}
