import { Fetcher } from '../src/utils/Fetcher.js';
import * as cheerio from 'cheerio';
import { getTmdbId, getTmdbNameAndYear } from '../src/utils/index.js';

const f = new Fetcher(console);
const ctx = { hostUrl: new URL('http://localhost'), config: {}, ip: '127.0.0.1' };

const tmdbId = await getTmdbId(f, ctx, { id: 'tt11198330', season: 1, episode: 1 });
const [name, year] = await getTmdbNameAndYear(f, ctx, tmdbId);
console.log('Name:', name, 'Year:', year);

const searchUrl = new URL(`/?s=${encodeURIComponent(name)}`, 'https://new1.moviesdrive.christmas');
console.log('Search URL:', searchUrl.href);
const html = await f.text(ctx, searchUrl);
console.log('HTML length:', html.length);
const $ = cheerio.load(html);
const links = [];
$('a').each((_i, el) => {
  const href = $(el).attr('href');
  const text = $(el).text().trim();
  if (href && href.includes('moviesdrive.christmas/') && !href.includes('?s=') && !href.includes('/category/') && !href.includes('/page/') && !href.includes('/feed/') && !href.includes('/tag/')) {
    links.push({ href, text: text.substring(0, 60) });
  }
});
console.log('Found links:', links.length);
for (const l of links.slice(0, 5)) console.log('  •', l.href, '|', l.text);
