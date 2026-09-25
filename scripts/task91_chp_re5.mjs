import * as cheerio from 'cheerio';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function search(label, body) {
  const r = await fetch('https://cinehdplus.surf/index.php?do=search&subaction=search', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const html = await r.text();
  const $ = cheerio.load(html);
  const titles = $('.card__title a[href]').toArray().map(el => $(el).text().trim() + ' :: ' + ($(el).attr('href') || '').split('/').pop());
  console.log(`== ${label} -> ${titles.length} results`);
  for (const t of titles.slice(0, 8)) console.log('   ' + t);
  return titles;
}
// 1) IMDB id search — deterministic matcher if the page body embeds the id
await search('IMDB tt1375666 (Inception)', 'story=tt1375666&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50');
await search('IMDB tt15239678 (Dune2)', 'story=tt15239678&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50');
// 2) search_start=1 variant for "Origen" — does the exact page appear?
await search('Origen start=1', 'story=Origen&do=search&subaction=search&search_start=1&full_search=0&result_from=1&result_num=50');
// 3) full_search=1 variant
await search('Origen full=1', 'story=Origen&do=search&subaction=search&search_start=0&full_search=1&result_from=1&result_num=50');
