// Mimic 9anime source's fetchAnimePageUrl
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

const BASE_URL = 'https://9anime.cl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const query = 'Demon Slayer';
  const searchUrl = new URL(`/?s=${encodeURIComponent(query)}`, BASE_URL);
  const res = await gotScraping.get(searchUrl, {
    headers: { 'User-Agent': UA },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  console.log('Status:', res.statusCode, 'Length:', res.body.length);

  const html = res.body;
  const $ = cheerio.load(html);

  // Find first 10 /anime/ links and show their text
  let count = 0;
  $('a[href*="/anime/"]').each((_i, el) => {
    if (count >= 10) return;
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!href || href.includes('/anime/?') || href.includes('/az-list') || href.includes('/genres/')) return;
    console.log(`  href=${href.slice(0, 80)}`);
    console.log(`    text="${text}" (length: ${text.length})`);
    // Check parent article for title
    const $article = $(el).closest('article');
    if ($article.length > 0) {
      const articleTitle = $article.find('h1, h2, h3, h4, h5, h6').first().text().trim();
      console.log(`    article h2/h3: "${articleTitle}"`);
    }
    count++;
  });
  console.log(`Total /anime/ links found: ${count}`);
}

main().catch(console.error);
