// Test hubcloud page fetch + token extraction
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const MAIN_URL = 'https://new3.moviesdrive.christmas';

// Step 1: Get the inception page from moviesdrive
console.log('1. Fetching moviesdrive inception page...');
const mdRes = await gotScraping(`${MAIN_URL}/inception-2010/`, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('  Status:', mdRes.statusCode, '| size:', mdRes.body.length);

// Find hubcloud links
const matches = [...mdRes.body.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?from_ac=([^&"'<]+)&(?:amp;)?q=([^"'<\s]+))"/g)];
console.log('  hubcloud links:', matches.length);
for (const m of matches.slice(0, 3)) {
  console.log('    from_ac:', m[2].slice(0, 30), '...', 'q:', Buffer.from(m[3], 'base64').toString('utf8'));
}

// Step 2: Visit the first hubcloud URL to get the REAL FROM_AC_TOKEN
if (matches.length > 0) {
  const first = matches[0][1].replace('hubcloud.foo', 'hubcloud.cx');
  console.log('\n2. Fetching hubcloud page to extract FROM_AC_TOKEN...');
  console.log('  URL:', first.slice(0, 100));
  const hcRes = await gotScraping(first, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': MAIN_URL + '/' },
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  console.log('  Status:', hcRes.statusCode, '| size:', hcRes.body.length);
  const tokenMatch = hcRes.body.match(/FROM_AC_TOKEN\s*=\s*"([^"]+)"/);
  if (tokenMatch) {
    console.log('  ✓ Real FROM_AC_TOKEN:', tokenMatch[1].slice(0, 40), '...');
    
    // Step 3: Now search with the real token
    const searchUrl = `https://hubcloud.cx/drive/search-recover.php?api=search&q=Inception%201080p&page=1&from_ac=${tokenMatch[1]}`;
    console.log('\n3. Searching hubcloud API with real token...');
    const sRes = await gotScraping(searchUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': first },
      timeout: { request: 15000 }, throwHttpErrors: false,
    });
    console.log('  Status:', sRes.statusCode);
    console.log('  Body (first 2000):', sRes.body.slice(0, 2000));
  } else {
    console.log('  ✗ No FROM_AC_TOKEN in page');
    console.log('  First 500 chars:', hcRes.body.slice(0, 500));
  }
}
