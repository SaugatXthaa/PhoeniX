// Search for embed provider URLs in the imdbplay.tech JS
import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Search for common embed provider patterns
const providers = [
  'vidsrc', '2embed', 'multiembed', 'embed.su', 'gomo', 'videasy',
  'vidlink', 'vidking', 'vixsrc', 'streamx', 'fmovies', 'soap2day',
  'moviesapi', 'superembed', 'autoembed', 'vidsrc.cc', 'vidsrc.to',
];

for (const p of providers) {
  const idx = js.toLowerCase().indexOf(p);
  if (idx >= 0) {
    const start = Math.max(0, idx - 50);
    const end = Math.min(js.length, idx + 100);
    console.log(`Found "${p}" at position ${idx}:`);
    console.log(`  ...${js.slice(start, end)}...`);
    console.log();
  }
}

// Look for template literals that build URLs with ${...}
const templates = [...js.matchAll(/`([^`]{5,200})`/g)];
console.log('URL templates with ${} variables:');
for (const m of templates) {
  const t = m[1];
  if (t.includes('http') && t.includes('$') && 
      (t.includes('embed') || t.includes('stream') || t.includes('video') || 
       t.includes('player') || t.includes('watch') || t.includes('play') || 
       t.includes('source') || t.includes('vid'))) {
    console.log(`  ${t.slice(0, 200)}`);
  }
}

// Look for .src assignments
const srcSets = [...js.matchAll(/\.src\s*=\s*([^;]{5,150})/gi)];
console.log('\n.src assignments:');
for (const m of [...new Set(srcSets.map(m => m[1]))].slice(0, 10)) {
  console.log(`  ${m.slice(0, 150)}`);
}

// Look for iframe creation
const iframeCreates = [...js.matchAll(/createElement\(["']iframe["']\)/gi)];
console.log(`\ncreateElement('iframe'): ${iframeCreates.length} matches`);

// Look for the "server" configuration array
const serverArrays = [...js.matchAll(/servers\s*[:=]\s*\[([^\]]{5,500})\]/gi)];
console.log('\nServer arrays:');
for (const m of serverArrays.slice(0, 5)) {
  console.log(`  ${m[1].slice(0, 200)}`);
}

// Look for any function that takes a server number and returns a URL
const serverUrlFns = [...js.matchAll(/(?:getServer|serverUrl|streamUrl|embedUrl|playerUrl|videoUrl|sourceUrl)\s*[:=]\s*(?:function|\([^)]*\)\s*=>)\s*[^;]{5,300}/gi)];
console.log('\nServer URL functions:');
for (const m of serverUrlFns.slice(0, 5)) {
  console.log(`  ${m[0].slice(0, 200)}`);
}

// Direct search for known patterns
console.log('\n=== Direct string search ===');
const patterns = ['vidsrc', '2embed', 'multiembed', 'gomo', 'videasy', 'vidlink',
                  'vidking', 'vixsrc', 'embed.su', 'autoembed', 'player.', 'stream.'];
for (const p of patterns) {
  const count = (js.match(new RegExp(p, 'gi')) || []).length;
  if (count > 0) console.log(`  ${p}: ${count} occurrences`);
}
