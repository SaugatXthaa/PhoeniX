import * as cheerio from 'cheerio';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function search(q) {
  const r = await fetch('https://cinehdplus.surf/index.php?do=search&subaction=search', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: `story=${encodeURIComponent(q)}&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50`,
    signal: AbortSignal.timeout(20000),
  });
  const html = await r.text();
  const $ = cheerio.load(html);
  const titles = $('.card__title a[href]').toArray().map(el => $(el).text().trim() + ' :: ' + ($(el).attr('href') || '').split('/').pop());
  console.log(`== "${q}" -> ${titles.length} results`);
  for (const t of titles.slice(0, 12)) console.log('   ' + t);
}
await search('El origen');
await search('Inception');
