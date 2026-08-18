// Dump the HTML structure around the series/demon-slayer link
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const url = 'https://watchanimeworld.top/?s=Demon+Slayer';

const res = await gotScraping.get(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 },
  throwHttpErrors: false,
});
const html = res.body;

// Find the index of 'series/demon-slayer' in the HTML
const idx = html.indexOf('series/demon-slayer');
if (idx === -1) {
  console.log('NOT FOUND');
} else {
  // Show 600 chars before and 400 after
  const start = Math.max(0, idx - 600);
  const end = Math.min(html.length, idx + 400);
  console.log('--- context around series/demon-slayer ---');
  console.log(html.slice(start, end));
}
