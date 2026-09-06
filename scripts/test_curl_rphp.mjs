import { gotScraping } from 'got-scraping';
import { execSync } from 'child_process';

// Step 1: Sign via got-scraping
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

// Step 2: Fetch r.php using system curl (different TLS fingerprint)
const curlResult = execSync(
  `curl -sS -L --max-time 15 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36" -H "Referer: https://mvlink.blog/" "${rphpUrl}"`,
  { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 20000 }
);
console.log('curl result size:', curlResult.length);

// Check if it's CF challenge
if (curlResult.includes('One moment')) {
  console.log('→ CF challenge page (curl also blocked)');
} else {
  console.log('→ Real content!');
  // Look for URLs
  const urls = [...curlResult.matchAll(/https?:\/\/[^"'\s<>]+/gi)];
  const filtered = [...new Set(urls.map(m => m[0]))].filter(u => 
    !u.includes('hshare.ink') && !u.includes('cloudflare') && !u.includes('w3.org')
  );
  console.log('URLs found:', filtered.length);
  for (const u of filtered.slice(0, 5)) console.log('  ', u.slice(0, 200));
  
  // Show body sample
  console.log('\nBody (first 500):');
  console.log(curlResult.slice(0, 500));
}
