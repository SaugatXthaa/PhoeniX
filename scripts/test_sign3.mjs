import { gotScraping } from 'got-scraping';

const hshareId = 'Inception.(2010).1080p.Dual.Audio.(Hin-Eng).mkv';
// Use base64 without padding (strip trailing =)
const b64 = Buffer.from(hshareId).toString('base64').replace(/=+$/, '');
const body = `action=hindshare_sign&d=${b64}`;
console.log('POST body:', body);

const r = await gotScraping.post('https://mvlink.blog/wp-admin/admin-ajax.php', {
  headers: {
    'User-Agent': 'Mozilla/5.0 Chrome/131',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://mvlink.blog/1287',
    'Accept': '*/*',
  },
  body,
  timeout: { request: 15000 },
  throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
console.log('Body:', r.body.slice(0, 500));

// If success, get the r.php URL and resolve it
if (r.statusCode === 200) {
  const data = JSON.parse(r.body);
  if (data?.success && data?.data?.url) {
    const rphpUrl = data.data.url;
    console.log('\nr.php URL:', rphpUrl.slice(0, 100));
    
    // Try to resolve via got-scraping
    const r2 = await gotScraping(rphpUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://mvlink.blog/' },
      timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log('r.php status:', r2.statusCode, '| size:', r2.body.length);
    
    if (!r2.body.includes('One moment')) {
      // Look for URLs
      const urls = [...r2.body.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
      const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
        !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org')
      );
      console.log('URLs:', filtered.slice(0, 5));
      console.log('Body (first 500):', r2.body.slice(0, 500));
    } else {
      console.log('→ CF challenge page');
    }
  }
}
