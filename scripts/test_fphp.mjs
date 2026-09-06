import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();

// Step 1: Sign
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
const signData = JSON.parse(signRes.body);
const rphpUrl = signData.data.url;

// Step 2: Fetch r.php (don't follow redirect — get the Location header)
const r = await gotScraping(rphpUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('r.php → Status:', r.statusCode, '| Location:', r.headers.location);

// Step 3: Resolve relative f.php URL and fetch it
if (r.headers.location) {
  const fphpUrl = new URL(r.headers.location, 'https://hshare.ink/').href;
  console.log('f.php URL:', fphpUrl.slice(0, 120));
  
  const r2 = await gotScraping(fphpUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': rphpUrl },
    cookieJar,
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: false,
  });
  console.log('f.php → Status:', r2.statusCode, '| Location:', r2.headers.location, '| size:', r2.body.length);
  
  if (r2.statusCode === 200 && r2.body) {
    // Look for direct URLs
    const urls = [...r2.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
    const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
      !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org') && !u.includes('tailwindcss')
    );
    console.log('URLs found:', filtered.length);
    for (const u of filtered.slice(0, 5)) console.log('  ', u.slice(0, 200));
    
    // Look for workers.dev / googleusercontent
    const workers = r2.body.match(/https?:\/\/[a-z0-9.-]+\.workers\.dev\/[^"'\s<>]+/gi);
    const gdrive = r2.body.match(/https?:\/\/[a-z0-9.-]*googleusercontent\.com\/[^"'\s<>]+/gi);
    console.log('workers.dev:', workers?.[0]?.slice(0, 150));
    console.log('googleusercontent:', gdrive?.[0]?.slice(0, 150));
    
    // Show body sample
    console.log('\nBody (first 1000):');
    console.log(r2.body.slice(0, 1000));
  }
  
  // Follow redirect if any
  if (r2.headers.location) {
    const finalUrl = new URL(r2.headers.location, 'https://hshare.ink/').href;
    console.log('\n=== Following redirect to:', finalUrl.slice(0, 100), '===');
    const r3 = await gotScraping(finalUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': fphpUrl },
      cookieJar,
      timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log('Final → Status:', r3.statusCode, '| size:', r3.body.length, '| url:', r3.url?.slice(0, 100));
    const urls = [...r3.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
    const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
      !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org')
    );
    console.log('URLs:', filtered.slice(0, 5));
  }
}
