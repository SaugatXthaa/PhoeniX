import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import * as cheerio from 'cheerio';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

const url = 'https://new2.zinkmovies.mobi/movies/the-dark-knight-2008/';
const r = await gotScraping.get(url, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), Accept: 'text/html' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});

const html = r.body;
// Find all external URLs
const urlMatches = [...html.matchAll(/https?:\/\/(?!new2\.zinkmovies|image\.tmdb|www\.zinkmovies)[a-z0-9.\-]+\.[a-z]{2,}[/a-zA-Z0-9._\-?=&]*/gi)];
const seen = new Set();
console.log('=== External URLs found ===');
for (const m of urlMatches) {
  const u = m[0];
  if (!seen.has(u) && !u.includes('.css') && !u.includes('.js') && !u.includes('.png') && !u.includes('.jpg') && !u.includes('google') && !u.includes('cloudflare') && !u.includes('fontawesome') && !u.includes('jquery') && !u.includes('cdn.jsdelivr')) {
    seen.add(u);
    console.log('  ' + u.slice(0, 120));
  }
}

// Also check for all <a> tags with external hrefs
const $ = cheerio.load(html);
console.log('\n=== <a> tags with external hrefs ===');
$('a').each((_i, el) => {
  const href = $(el).attr('href') || '';
  const text = $(el).text().trim();
  if (href.startsWith('http') && !href.includes('zinkmovies') && !href.includes('tmdb.org') && text.length > 3) {
    console.log('  text: "' + text.slice(0, 60) + '" | href: ' + href.slice(0, 80));
  }
});
