import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();
const url = 'https://hshare.ink/?id=Death.Note.Relight.1.Visions.Of.A.God.2007.720p.Bluray.Hindi.Japanese.mkv';

// First request — get CF challenge cookies
console.log('=== First request ===');
const r1 = await gotScraping(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Status:', r1.statusCode, '| size:', r1.body.length);

// Wait a bit
await new Promise(r => setTimeout(r, 2000));

// Second request — with CF cookies
console.log('\n=== Second request (with cookies) ===');
const r2 = await gotScraping(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Status:', r2.statusCode, '| size:', r2.body.length);

// Check for URLs
const urls = [...r2.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
console.log('\nURLs found:');
for (const u of [...new Set(urls.map(m => m[0]))]) {
  if (!u.includes('hshare') && !u.includes('cloudflare') && !u.includes('tailwindcss') && !u.includes('w3.org')) {
    console.log('  ', u.slice(0, 200));
  }
}

// Show first 2000 chars
console.log('\nBody sample:');
console.log(r2.body.slice(0, 2000));
