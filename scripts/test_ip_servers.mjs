// Find server URLs in the imdbplay.tech movie page
import fs from 'fs';

const html = fs.readFileSync('/tmp/ip_movie3.html', 'utf-8');

// Find all Server buttons
const buttonMatches = [...html.matchAll(/<button[^>]*>(Server\s+\d+)<\/button>/gi)];
console.log(`Found ${buttonMatches.length} server buttons:`);
for (const m of buttonMatches) console.log(`  ${m[1]}`);

// Find onclick handlers or data attributes
const onClickMatches = [...html.matchAll(/onclick="([^"]+)"/gi)];
console.log(`\nOnclick handlers: ${onClickMatches.length}`);
for (const m of onClickMatches.slice(0, 5)) console.log(`  ${m[1].slice(0, 150)}`);

// Find all unique external URLs (excluding TMDB images, Google fonts, etc.)
const urlMatches = [...html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]+)\/[a-z0-9/_?=&.-]+/gi)];
const uniqueHosts = new Set();
const uniqueUrls = new Set();
for (const m of urlMatches) {
  const host = m[1];
  if (!['fonts.googleapis.com', 'image.tmdb.org', 'www.w3.org', 'static.cloudflareinsights.com',
        'addons.mozilla.org', 'microsoftedge.microsoft.com', 'github.com', 'www.warnerbros.com',
        'www.youtube-nocookie.com'].includes(host)) {
    uniqueHosts.add(host);
    uniqueUrls.add(m[0]);
  }
}
console.log(`\nUnique non-standard hosts: ${[...uniqueHosts].sort()}`);
console.log(`Unique non-standard URLs:`);
for (const u of uniqueUrls) console.log(`  ${u.slice(0, 200)}`);

// Look for the server URL configuration in inline scripts
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
console.log(`\nInline scripts: ${scripts.length}`);
for (let i = 0; i < scripts.length; i++) {
  const content = scripts[i][1].trim();
  if (content.length > 50 && content.includes('server')) {
    console.log(`\nScript ${i} (${content.length} chars, has 'server'):`);
    console.log(content.slice(0, 500));
  }
}

// Look for the server switch function
const switchMatch = html.match(/(?:switch|select|change|set)[Ss]erver\s*\([^)]*\)\s*\{[^}]{0,500}/);
if (switchMatch) console.log(`\nSwitch server function: ${switchMatch[0].slice(0, 300)}`);

// Look for the stream URL builder
const streamMatch = html.match(/(?:stream|video|player|source|embed)[Uu]rl\s*[:=]\s*[^;]{5,200}/);
if (streamMatch) console.log(`\nStream URL: ${streamMatch[0].slice(0, 200)}`);

// Check if there's a __TSR_DATA__ or similar TanStack data blob
const tsrMatch = html.match(/__TSR[A-Z_]*\s*=\s*[^;]{5,500}/);
if (tsrMatch) console.log(`\nTSR data: ${tsrMatch[0].slice(0, 300)}`);

// Look for stream URLs in the page that might be server-specific
const streamUrls = [...html.matchAll(/https?:\/\/[^"'<>\s]+(?:stream|video|player|embed|source|watch|play|vid|media)[^"'<>\s]*/gi)];
console.log(`\nStream-like URLs: ${streamUrls.length}`);
for (const m of [...new Set(streamUrls.map(m => m[0]))].slice(0, 10)) {
  console.log(`  ${m.slice(0, 200)}`);
}
