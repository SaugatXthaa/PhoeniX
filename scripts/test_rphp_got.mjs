import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();

// Step 1: Get the signed r.php URL from admin-ajax
const signRes = await gotScraping.post('https://mvlink.blog/wp-admin/admin-ajax.php', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://mvlink.blog/892',
  },
  body: 'action=hindshare_sign&d=SW5jZXB0aW9uLigyMDEwKS4xMDgwcC5EdWFsLkF1ZGlvLihIaW4tRW5nKS5ta3Y',
  timeout: { request: 15000 },
  throwHttpErrors: false,
});
console.log('Sign status:', signRes.statusCode, '| body:', signRes.body.slice(0, 300));

// Step 2: Fetch r.php URL with got-scraping (CF bypass)
const rphpUrl = signRes.body.trim();
if (rphpUrl.startsWith('http')) {
  console.log('\n=== Fetching r.php with got-scraping ===');
  const r = await gotScraping(rphpUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
    cookieJar,
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: false,
  });
  console.log('Status:', r.statusCode, '| location:', r.headers.location, '| size:', r.body.length);
  
  if (r.statusCode === 200) {
    // Look for URLs
    const urls = [...r.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
    console.log('URLs found:', [...new Set(urls.map(m => m[0]))].slice(0, 10));
    
    // Look for redirect/meta refresh
    const metaRefresh = r.body.match(/url=([^"'>\s]+)/i);
    if (metaRefresh) console.log('Meta refresh:', metaRefresh[1]);
    
    // Look for workers.dev / googleusercontent
    const workers = r.body.match(/https?:\/\/[a-z0-9.-]+\.workers\.dev\/[^"'\s<>]+/gi);
    const gdrive = r.body.match(/https?:\/\/[a-z0-9.-]*googleusercontent\.com\/[^"'\s<>]+/gi);
    console.log('workers.dev:', workers?.slice(0, 2));
    console.log('googleusercontent:', gdrive?.slice(0, 2));
    
    // Show body sample
    console.log('\nBody sample (first 1000):');
    console.log(r.body.slice(0, 1000));
  }
  
  // If redirect, follow it
  if (r.headers.location) {
    console.log('\n=== Following redirect ===');
    const r2 = await gotScraping(r.headers.location, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': rphpUrl },
      cookieJar,
      timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log('Status:', r2.statusCode, '| size:', r2.body.length, '| url:', r2.url);
    const urls = [...r2.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
    console.log('URLs:', [...new Set(urls.map(m => m[0]))].filter(u => !u.includes('hshare') && !u.includes('cloudflare')).slice(0, 10));
  }
}
