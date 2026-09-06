import { gotScraping } from 'got-scraping';

const url = 'https://hshare.ink/?id=Death.Note.Relight.1.Visions.Of.A.God.2007.720p.Bluray.Hindi.Japanese.mkv';
const r = await gotScraping(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);

// Look for ALL URLs
const urls = [...r.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
console.log('\nAll URLs:');
for (const u of [...new Set(urls.map(m => m[0]))]) {
  if (!u.includes('hshare') && !u.includes('cloudflare') && !u.includes('tailwindcss')) {
    console.log('  ', u.slice(0, 200));
  }
}

// Look for known file hosts
const hosts = ['gdtot', 'gdflix', 'hubcloud', 'fastdl', 'filepress', 'drive.google', 'googleusercontent', 'workers.dev', 'r2.dev', 'pixeldrain', '1fichier', 'mediafire', 'gofile', 'nexdrive', 'filemoon', 'doodstream', 'streamwish', 'gamerxyt', 'gpdl'];
for (const h of hosts) {
  if (r.body.toLowerCase().includes(h)) {
    console.log(`\nFound ${h}:`);
    const matches = [...r.body.matchAll(new RegExp(`https?://[^"'\\s<>]*${h}[^"'\\s<>]*`, 'gi'))];
    for (const m of matches.slice(0, 3)) {
      console.log('  ', m[0].slice(0, 200));
    }
  }
}

// Look for meta refresh or JS redirect
const metaRefresh = r.body.match(/meta[^>]*refresh[^>]*content=["'][^"']*["'][^>]*url=([^"'>\s]+)/i);
if (metaRefresh) console.log('\nMeta refresh URL:', metaRefresh[1]);

const jsRedirect = r.body.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
if (jsRedirect) console.log('\nJS redirect URL:', jsRedirect[1]);

// Show full body
console.log('\n=== Full body ===');
console.log(r.body);
