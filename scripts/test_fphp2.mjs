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
console.log('r.php URL:', rphpUrl.slice(0, 80));

// Step 2: Fetch r.php with followRedirect=true (follow all redirects)
const r = await gotScraping(rphpUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Final Status:', r.statusCode, '| size:', r.body.length, '| url:', r.url?.slice(0, 100));

// Check if it's the CF challenge page or actual content
if (r.body.includes('One moment')) {
  console.log('→ Cloudflare challenge page detected');
  // Try fetching again with the same cookies (CF might have cleared)
  await new Promise(resolve => setTimeout(resolve, 2000));
  const r2 = await gotScraping(rphpUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
    cookieJar,
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  console.log('Retry Status:', r2.statusCode, '| size:', r2.body.length);
  if (!r2.body.includes('One moment')) {
    console.log('→ CF bypassed!');
    const urls = [...r2.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
    const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
      !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org')
    );
    console.log('URLs:', filtered.slice(0, 5));
    console.log('Body (first 500):', r2.body.slice(0, 500));
  }
} else {
  // Not CF challenge — look for URLs
  const urls = [...r.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
  const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
    !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org')
  );
  console.log('URLs:', filtered.slice(0, 5));
  console.log('Body (first 500):', r.body.slice(0, 500));
}
