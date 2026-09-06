import { gotScraping } from 'got-scraping';

// The post ID from the page was 211654
const r = await gotScraping('https://mobilejsr.rest/wp-json/wp/v2/posts/211654', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json', 'Referer': 'https://mobilejsr.rest/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
if (r.statusCode === 200) {
  try {
    const data = JSON.parse(r.body);
    const content = data.content?.rendered || '';
    console.log('Content length:', content.length);
    // Find all URLs in the content
    const urls = [...content.matchAll(/href="([^"]+)"/g)];
    console.log('Links found:', urls.length);
    for (const m of urls) {
      if (!m[1].includes('mobilejsr') && !m[1].includes('google') && !m[1].includes('font') && !m[1].includes('wordpress')) {
        console.log('  ', m[1].slice(0, 200));
      }
    }
    // Also search for any URLs in the raw content
    const rawUrls = [...content.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]+\/[a-z0-9/_?=&.-]+/gi)];
    console.log('\nAll URLs in content:', rawUrls.length);
    for (const m of [...new Set(rawUrls.map(m => m[0]))]) {
      if (!m.includes('mobilejsr') && !m.includes('google') && !m.includes('font') && !m.includes('wordpress') && !m.includes('schema') && !m.includes('w3.org')) {
        console.log('  ', m.slice(0, 200));
      }
    }
  } catch (e) {
    console.log('JSON parse error:', e.message);
    console.log('Body sample:', r.body.slice(0, 500));
  }
} else {
  console.log('Body:', r.body.slice(0, 500));
}
