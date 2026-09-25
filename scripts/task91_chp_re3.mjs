// Task 91 RE round 3: full candidate dump for the two real TMDB-es names —
// confirm the correct pages ARE in the result set (fuzzy match will find them).
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
  for (const t of titles) console.log('   ' + t);
  // also check year presence in one card's outer HTML
  const card = $('.card__title').first().closest('.card').html() || $('.card__title').first().parent().html() || '';
  const yearHit = card.match(/19\d\d|20\d\d/g);
  console.log('   year-in-card:', yearHit ? yearHit.slice(0,3) : 'none');
}
await search('Origen');
await search('Dune: Parte dos');
