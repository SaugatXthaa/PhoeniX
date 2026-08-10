// Check CineFreak download link structure for 4K movies
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const BASE_URL = 'https://cinefreak.net';

async function fetchPage(url) {
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  return res.statusCode === 200 ? res.body : null;
}

// Search for Spider-Man: Homecoming (a movie that has 4K)
const searchUrl = `${BASE_URL}/?s=${encodeURIComponent('Spider-Man Homecoming')}`;
const html = await fetchPage(searchUrl);
if (!html) { console.log('Search failed'); process.exit(1); }

const $ = cheerio.load(html);
console.log('=== Search results ===');
$('a.movie-card').each((_, el) => {
  const href = $(el).attr('href');
  const title = ($(el).attr('aria-label') || $(el).find('.movie-card-title').text() || '').trim();
  console.log(`  ${title} → ${href}`);
});

// Get the first result's detail page
const firstCard = $('a.movie-card').first();
const detailUrl = $(firstCard).attr('href');
if (!detailUrl) { console.log('No results'); process.exit(0); }

console.log(`\n=== Detail page: ${detailUrl} ===`);
const detailHtml = await fetchPage(detailUrl);
if (!detailHtml) { console.log('Detail page failed'); process.exit(1); }

const $detail = cheerio.load(detailHtml);

// Find ALL download links (not just dlbtn-download)
console.log('\n=== ALL a.dlbtn links ===');
$detail('a.dlbtn').each((_, el) => {
  const href = $(el).attr('href');
  const classes = $(el).attr('class') || '';
  const text = $(el).text().trim().slice(0, 50);
  // Find quality from nearby h4
  const $container = $(el).closest('.dlbtn-container');
  let h4Text = '';
  if ($container.length) {
    h4Text = $container.prev('h4.movie-title').text().trim() ||
             $container.find('h4').text().trim();
  }
  console.log(`  class="${classes}" | h4="${h4Text}" | text="${text}" | href=${href?.slice(0, 80)}`);
});

// Also check for 4K-specific elements
console.log('\n=== Look for 4K/2160p mentions ===');
const allText = detailHtml;
const matches4k = [...allText.matchAll(/4k|2160p|uhd/gi)];
console.log(`4K mentions: ${matches4k.length}`);
for (const m of matches4k.slice(0, 10)) {
  const i = m.index;
  console.log(`  @${i}: ...${allText.slice(Math.max(0, i-50), i+80).replace(/\n/g, ' ')}...`);
}

// Check h4 elements
console.log('\n=== All h4 elements ===');
$detail('h4').each((_, el) => {
  const text = $(el).text().trim();
  if (text) console.log(`  h4: "${text}"`);
});
