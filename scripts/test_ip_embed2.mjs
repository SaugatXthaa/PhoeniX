import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://www.imdbplay.tech/assets/index-BJQ3t9Je.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;

// Search for common embed provider patterns
const providers = [
  'vidsrc', 'vidsrc.to', 'vidsrc.me', '2embed', 'multiembed', 'embed.su',
  'gomo', 'videasy', 'vidlink', 'vidking', 'vixsrc', 'streamx', 'fmovies',
  'soap2day', 'moviesapi', 'movie-web', 'superembed', 'multiembed.mov',
  'embed.smashystream', '2embed.cc', 'vidsrc.xyz', 'vidsrc.in',
  'embed.warez', 'multimovies', 'aniizy', 'vidsrc.net', '2embed.io',
  'autoembed', 'player', 'watch', 'play', 'video', 'source',
];

for (const p of providers) {
  const regex = new RegExp(`["'\`][^"'\\`]{0,50}${p}[^"'\\`]{0,50}["'\`]`, 'gi');
  const matches = [...js.matchAll(regex)];
  if (matches.length > 0) {
    console.log(`${p}: ${matches.length} matches`);
    for (const m of [...new Set(matches.map(m => m[0]))].slice(0, 3)) {
      console.log(`  ${m}`);
    }
  }
}

// Also look for template literals that build embed URLs
const templates = [...js.matchAll(/`([^`]*https?:\/\/[^`]*\$\{[^`]+[^`]*)`/g)];
console.log('\nURL templates with variables:');
for (const m of [...new Set(templates.map(m => m[1]))]) {
  if (m.includes('embed') || m.includes('stream') || m.includes('video') || m.includes('player') || m.includes('watch') || m.includes('play') || m.includes('source') || m.includes('vid')) {
    console.log(`  ${m.slice(0, 200)}`);
  }
}

// Look for "src" property set on iframe elements
const srcSets = [...js.matchAll(/\.src\s*=\s*([^;]{5,150})/gi)];
console.log('\n.src assignments:');
for (const m of [...new Set(srcSets.map(m => m[1]))].slice(0, 10)) {
  console.log(`  ${m.slice(0, 150)}`);
}
