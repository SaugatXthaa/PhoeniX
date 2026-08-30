'use strict';

const cheerio = require('cheerio');

async function main() {
  const res = await fetch('https://4khdhub.one/?s=Moana', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  console.log('All moana-related slugs on 4khdhub.one:');
  const seen = new Set();
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('moana')) return;
    // Only show post URLs
    if (!href.match(/-(?:movie|series)-\d+\/?$/)) return;
    if (seen.has(href)) return;
    seen.add(href);
    const text = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 80);
    console.log('  ', href, '→', text);
  });
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
