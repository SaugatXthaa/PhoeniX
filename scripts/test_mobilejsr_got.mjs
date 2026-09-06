import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://mobilejsr.rest/genxfm784776495505/', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cinevood.love/' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log('Status:', r.statusCode, '| size:', r.body.length, '| url:', r.url);

// Find ALL href values
const hrefs = [...r.body.matchAll(/href="([^"]+)"/g)];
console.log('\nAll hrefs:', hrefs.length);
for (const m of hrefs) {
  if (!m[1].includes('mobilejsr') && !m[1].includes('google') && !m[1].includes('font') && !m[1].includes('wordpress') && !m[1].includes('gmpg') && !m[1].includes('w3.org')) {
    console.log('  ', m[1].slice(0, 150));
  }
}

// Find ALL URLs in the page
const urls = [...r.body.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]+\/[a-z0-9/_?=&.-]+/gi)];
console.log('\nAll URLs:', urls.length);
const uniqueUrls = [...new Set(urls.map(m => m[0]))];
for (const u of uniqueUrls) {
  if (!u.includes('mobilejsr') && !u.includes('google') && !u.includes('font') && !u.includes('wordpress') && !u.includes('gmpg') && !u.includes('w3.org') && !u.includes('cloudflare') && !u.includes('jsdelivr') && !u.includes('unpkg') && !u.includes('sharethis') && !u.includes('googletagmanager') && !u.includes('schema') && !u.includes('gravatar') && !u.includes('wikimedia')) {
    console.log('  ', u.slice(0, 150));
  }
}

// Find data-url, data-link, data-href attributes
const dataAttrs = [...r.body.matchAll(/data-(?:url|link|href|src|download)="([^"]+)"/gi)];
console.log('\nData attributes:', dataAttrs.length);
for (const m of dataAttrs) {
  console.log('  ', m[1].slice(0, 150));
}

// Find the unlock/download section
const unlockMatch = r.body.match(/unlock[\s\S]{0,3000}/i);
if (unlockMatch) {
  console.log('\n=== Unlock section ===');
  // Find URLs in the unlock section
  const unlockUrls = [...unlockMatch[0].matchAll(/https?:\/\/[^"'\s<>]+/gi)];
  for (const u of unlockUrls) {
    console.log('  ', u[0].slice(0, 150));
  }
  // Find AJAX calls
  const ajaxCalls = [...unlockMatch[0].matchAll(/(?:fetch|ajax|XMLHttpRequest|\$\.post|\$\.get)\([^)]+\)/gi)];
  for (const a of ajaxCalls) {
    console.log('  AJAX:', a[0].slice(0, 200));
  }
}
