// Task 91 RE round 2: the search WORKS — so why "no exact match"? Probe with
// the exact TMDB-es names the addon searches and dump the result TITLES.
import * as cheerio from 'cheerio';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const normalizeTitle = (s) => (s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function search(q) {
  const r = await fetch('https://cinehdplus.surf/index.php?do=search&subaction=search', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: `story=${encodeURIComponent(q)}&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50`,
    signal: AbortSignal.timeout(20000),
  });
  const html = await r.text();
  const $ = cheerio.load(html);
  const titles = $('.card__title a[href]').toArray().map(el => ({
    text: $(el).text().trim(), href: $(el).attr('href'),
  }));
  console.log(`\n== "${q}" -> HTTP ${r.status} ${html.length}B, ${titles.length} card__title results`);
  for (const t of titles.slice(0, 10)) {
    console.log(`   [${normalizeTitle(t.text)}] ${t.text}  -> ${t.href?.split('/').pop()}`);
  }
  console.log(`   wanted normalized: "${normalizeTitle(q)}" — exact hit: ${titles.some(t => normalizeTitle(t.text) === normalizeTitle(q))}`);
  return { html, titles };
}

await search('Origen');            // TMDB-es for Inception
await search('Dune: Parte dos');   // TMDB-es for Dune: Part Two
await search('Dune Parte dos');    // no-colon variant
await search('CasaBlanca');        // TMDB-es for Casablanca — a control
