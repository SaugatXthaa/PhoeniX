import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://new3.moviesdrive.christmas/your-name-2016/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Find all unique link hosts
const allLinks = [...r.body.matchAll(/href="(https?:\/\/[^"]+)"/g)];
const hosts = new Set();
for (const m of allLinks) {
  try {
    const u = new URL(m[1]);
    hosts.add(u.hostname);
  } catch {}
}
console.log('Unique hosts:', [...hosts].sort());

// Look for any links with "download" or quality keywords in the link text
const linkWithText = [...r.body.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
console.log('\nLinks with download/quality text:');
for (const m of linkWithText) {
  const text = m[2].replace(/<[^>]+>/g, '').trim();
  if (/download|480p|720p|1080p|2160p|4k|bluray|web-dl/i.test(text) && text.length < 100) {
    console.log('  text:', text);
    console.log('  href:', m[1].slice(0, 120));
    console.log('');
  }
}
