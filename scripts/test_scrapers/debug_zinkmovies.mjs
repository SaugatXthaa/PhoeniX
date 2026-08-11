// Debug ZinkMovies search for The Dark Knight
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import * as cheerio from 'cheerio';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const BASE_URL = 'https://new2.zinkmovies.mobi';

const searchUrl = new URL(`/?s=${encodeURIComponent('The Dark Knight')}`, BASE_URL);
console.log('Search URL:', searchUrl.href);

const res = await gotScraping.get(searchUrl.href, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), Accept: 'text/html' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});

console.log('Status:', res.statusCode, '| Body len:', res.body.length);

const $ = cheerio.load(res.body);

// Find ALL links that contain /movies/
console.log('\n=== All links containing /movies/ ===');
$('a[href*="/movies/"]').each((_i, el) => {
  const href = $(el).attr('href');
  const text = $(el).text().trim().slice(0, 80);
  const title = $(el).attr('title') || '';
  if (href && !href.includes('category/') && !href.includes('?s=')) {
    console.log(`  href: ${href}`);
    console.log(`  text: "${text}"`);
    console.log(`  title attr: "${title}"`);
    console.log();
  }
});

// Also check for other link patterns
console.log('=== All links containing "dark" or "knight" ===');
$('a').each((_i, el) => {
  const href = $(el).attr('href') || '';
  const text = $(el).text().trim();
  if ((text.toLowerCase().includes('dark') || text.toLowerCase().includes('knight')) && text.length > 5) {
    console.log(`  text: "${text.slice(0, 80)}" | href: ${href.slice(0, 80)}`);
  }
});
