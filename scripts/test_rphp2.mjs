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
console.log('r.php URL:', rphpUrl);

// Step 2: Fetch r.php with got-scraping (CF bypass)
console.log('\n=== Fetching r.php ===');
const r = await gotScraping(rphpUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: false,
});
console.log('Status:', r.statusCode, '| location:', r.headers.location, '| size:', r.body.length);

if (r.statusCode === 200) {
  // Look for ALL URLs
  const urls = [...r.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
  const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
    !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org') && !u.includes('tailwindcss')
  );
  console.log('URLs found:', filtered.length);
  for (const u of filtered.slice(0, 10)) console.log('  ', u.slice(0, 200));
  
  // Look for workers.dev / googleusercontent
  const workers = r.body.match(/https?:\/\/[a-z0-9.-]+\.workers\.dev\/[^"'\s<>]+/gi);
  const gdrive = r.body.match(/https?:\/\/[a-z0-9.-]*googleusercontent\.com\/[^"'\s<>]+/gi);
  console.log('workers.dev:', workers?.[0]?.slice(0, 150));
  console.log('googleusercontent:', gdrive?.[0]?.slice(0, 150));
  
  // Show body sample
  console.log('\nBody sample (first 500):');
  console.log(r.body.slice(0, 500));
}

// Follow redirect
if (r.headers.location) {
  console.log('\n=== Following redirect to:', r.headers.location.slice(0, 100), '===');
  const r2 = await gotScraping(r.headers.location, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': rphpUrl },
    cookieJar,
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  console.log('Status:', r2.statusCode, '| size:', r2.body.length, '| url:', r2.url?.slice(0, 100));
  const urls = [...r2.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
  const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
    !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org')
  );
  console.log('URLs:', filtered.slice(0, 5));
}
