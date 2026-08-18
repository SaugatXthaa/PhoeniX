// Mimic AnimeSalt source's searchSite function exactly to see what it parses
const cheerio = require('cheerio');

const BASE = 'https://animesalt.link';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function test() {
  const url = BASE + '/?s=' + encodeURIComponent('Demon Slayer: Kimetsu no Yaiba');
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' } });
  const html = await r.text();
  console.log('html length:', html.length);

  // Replicate source's regex
  const results = [];
  const containerMatch = html.match(/id="movies-a"([\s\S]*?)(?=<footer|id="footer|class="footer)/m);
  const searchHtml = containerMatch ? containerMatch[1] : html;
  console.log('container found:', !!containerMatch, 'searchHtml length:', searchHtml.length);

  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/g;
  let articleMatch;
  let articleCount = 0;
  while ((articleMatch = articleRegex.exec(searchHtml)) !== null) {
    articleCount++;
    const articleHtml = articleMatch[1];
    const linkMatch = articleHtml.match(/href="(https:\/\/animesalt.link\/(series|movies)\/([^\/\"]+)\/?)"/);
    const titleMatch = articleHtml.match(/class="entry-title"[^>]*>([^<]+)</);
    const yearMatch = articleHtml.match(/class="year"[^>]*>(\d{4})</);

    console.log(`\n--- article ${articleCount} ---`);
    console.log('  linkMatch:', linkMatch ? linkMatch[1] : 'NONE', '(type:', linkMatch ? linkMatch[2] : 'NONE', ')');
    console.log('  title:', titleMatch ? titleMatch[1].trim() : 'NONE');
    console.log('  year:', yearMatch ? yearMatch[1] : 'NONE');

    if (linkMatch && titleMatch) {
      const slug = linkMatch[3];
      const type = linkMatch[2];
      const itemTitle = titleMatch[1].trim();
      const itemYear = yearMatch ? parseInt(yearMatch[1]) : null;
      const exists = results.some(r => r.slug === slug);
      if (!exists && slug && slug !== 'page') {
        results.push({ url: linkMatch[1], type, slug, title: itemTitle, year: itemYear });
      }
    }
  }
  console.log(`\nTotal articles found: ${articleCount}`);
  console.log('Results:', JSON.stringify(results, null, 2));
}

test().catch(e => { console.error(e); process.exit(1); });
