import { gotScraping } from 'got-scraping';
import fs from 'fs';

const r = await gotScraping('https://www.imdbplay.tech/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const html = r.body;
fs.writeFileSync('/tmp/ip_full_movie.html', html);

// Find ALL iframes
const iframes = [...html.matchAll(/<iframe[^>]*>/gi)];
console.log('Iframes:', iframes.length);
for (const m of iframes) {
  const src = m[0].match(/src="([^"]+)"/);
  const dataApi = m[0].match(/data-api="([^"]+)"/);
  console.log('  src:', src?.[1]?.slice(0, 150) || 'none');
  console.log('  data-api:', dataApi?.[1]?.slice(0, 150) || 'none');
  console.log('  full:', m[0].slice(0, 300));
  console.log();
}

// Find ALL unique URLs in the page
const allUrls = [...html.matchAll(/https?:\/\/[^"'<>\s]+/gi)];
const unique = [...new Set(allUrls.map(m => m[0]))].filter(u => 
  !u.includes('imdbplay.tech/og') && !u.includes('fonts.googleapis') && 
  !u.includes('fonts.gstatic') && !u.includes('cloudflare') && 
  !u.includes('jsdelivr') && !u.includes('unpkg') && !u.includes('w3.org') &&
  !u.includes('schema') && !u.includes('react.dev') && !u.includes('github.com') &&
  !u.includes('mozilla.org') && !u.includes('microsoft.com') && !u.includes('x.com') &&
  !u.includes('image.tmdb') && !u.includes('warnerbros') && !u.includes('youtube')
);
console.log('\nNon-standard URLs:', unique.length);
for (const u of unique) console.log('  ', u.slice(0, 200));

// Look for the "Server" buttons and their associated data
const serverSection = html.match(/Server\s*1.*?(?:<script|<\/section|<\/div>\s*<\/div>\s*<\/main)/is);
if (serverSection) {
  // Find all data attributes in the server section
  const dataAttrs = [...serverSection[0].matchAll(/data-([a-z-]+)="([^"]+)"/gi)];
  console.log('\nServer section data attributes:', dataAttrs.length);
  for (const m of [...new Set(dataAttrs.map(m => `${m[1]}=${m[2]}`))].slice(0, 10)) {
    console.log('  ', m.slice(0, 150));
  }
}

// Look for any JSON in script tags that might contain server configs
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
console.log('\nInline scripts:', scripts.length);
for (let i = 0; i < scripts.length; i++) {
  const content = scripts[i][1].trim();
  if (content.length > 100 && (content.includes('server') || content.includes('embed') || content.includes('stream') || content.includes('source'))) {
    console.log(`\nScript ${i} (${content.length} chars):`);
    console.log(content.slice(0, 500));
  }
}

// Look for the SSR data that TanStack Start embeds
const ssrData = html.match(/self\.\$_?TSR[A-Z_]*\s*=\s*[^;]{5,500}/);
if (ssrData) {
  console.log('\nSSR data:', ssrData[0].slice(0, 300));
}

// Look for the stream barrier data
const streamBarrier = html.match(/\$tsr-stream-barrier[^>]*>([^<]+)/);
if (streamBarrier) console.log('\nStream barrier:', streamBarrier[1].slice(0, 200));

// Find ALL text that looks like a URL with embed/player/stream
const embedTexts = [...html.matchAll(/["']([^"']*(?:embed|player|stream|source|video|watch)[^"']{5,100})["']/gi)];
console.log('\nEmbed-like strings:');
for (const m of [...new Set(embedTexts.map(m => m[1]))].slice(0, 10)) {
  if (m.includes('http') || m.includes('/')) console.log('  ', m.slice(0, 150));
}
