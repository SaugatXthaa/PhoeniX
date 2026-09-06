import { gotScraping } from 'got-scraping';

// Try WP REST API on mvlink.blog
const r = await gotScraping('https://mvlink.blog/wp-json/wp/v2/posts/55951', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Status:', r.statusCode, '| size:', r.body.length);
if (r.statusCode === 200) {
  try {
    const data = JSON.parse(r.body);
    const content = data.content?.rendered || '';
    console.log('Content length:', content.length);
    // Find ALL URLs
    const urls = [...content.matchAll(/href="([^"]+)"/g)];
    console.log('Links:', urls.length);
    for (const m of urls) {
      console.log('  ', m[1].slice(0, 200));
    }
    // Also find hshare URLs
    const hshareUrls = [...content.matchAll(/https?:\/\/hshare\.ink\/[^"'\s<>]+/gi)];
    console.log('\nhshare URLs:', hshareUrls.length);
    for (const m of hshareUrls) {
      console.log('  ', m[0].slice(0, 200));
    }
  } catch (e) {
    console.log('Parse error:', e.message);
    console.log('Body:', r.body.slice(0, 500));
  }
}
