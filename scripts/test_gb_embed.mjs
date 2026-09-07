import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://proxy.garageband.rocks/embed/movie/tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://www.imdbplay.tech/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

console.log('Status:', r.statusCode, '| size:', r.body.length);

// Find ALL iframes
const iframes = [...r.body.matchAll(/<iframe[^>]*>/gi)];
console.log('\nIframes:', iframes.length);
for (const m of iframes) {
  console.log('  ', m[0].slice(0, 300));
}

// Find ALL script sources
const scripts = [...r.body.matchAll(/<script[^>]*src="([^"]+)"/gi)];
console.log('\nScripts:', scripts.length);
for (const m of scripts) console.log('  ', m[1]);

// Find ALL inline scripts with server/stream logic
const inlineScripts = [...r.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
console.log('\nInline scripts:', inlineScripts.length);
for (let i = 0; i < inlineScripts.length; i++) {
  const content = inlineScripts[i][1].trim();
  if (content.length > 100 && (content.includes('server') || content.includes('stream') || content.includes('source') || content.includes('embed'))) {
    console.log(`\nScript ${i} (${content.length} chars):`);
    // Look for URLs
    const urls = content.match(/https?:\/\/[^"'\s<>]+/gi);
    if (urls) {
      console.log('  URLs:', [...new Set(urls)].slice(0, 5));
    }
    // Look for server configs
    const servers = content.match(/server\s*[:=]\s*[^,;}]{5,100}/gi);
    if (servers) {
      console.log('  Server configs:', servers.slice(0, 3));
    }
    // Show first 500 chars
    console.log('  Content:', content.slice(0, 500));
  }
}

// Find ALL external URLs
const allUrls = [...r.body.matchAll(/https?:\/\/[^"'<>\s]+/gi)];
const unique = [...new Set(allUrls.map(m => m[0]))].filter(u => 
  !u.includes('garageband.rocks') && !u.includes('google') && !u.includes('font') &&
  !u.includes('cloudflare') && !u.includes('jsdelivr') && !u.includes('w3.org') &&
  !u.includes('youtube') && !u.includes('histats')
);
console.log('\nExternal URLs:', unique.length);
for (const u of unique) console.log('  ', u.slice(0, 200));
