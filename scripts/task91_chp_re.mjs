// Task 91: cinehdplus search RE — the search returns query-DEPENDENT pages
// (86444B for "Origen" vs 48587B for "Dune: Parte dos") but `.card__title a`
// matches nothing. Find the current result markup + form semantics.
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function dump(label, url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'user-agent': UA, ...(opts.headers || {}) },
      body: opts.body,
      signal: AbortSignal.timeout(20000),
    });
    const html = await r.text();
    console.log(`\n=== ${label}: HTTP ${r.status} ${html.length}B ${Date.now() - t0}ms final=${r.url}`);
    const $ = cheerio.load(html);
    // candidate result selectors, old and common DLE ones
    for (const sel of ['.card__title a', '.card a', '.short a', '.search-results a',
      'a[href*="/peliculas/"]', 'a[href*="/series/"]', 'a[href*=".html"]',
      '.searchList li', '.result a', 'h4 a', 'h5 a', 'h3 a', '.title a']) {
      const n = $(sel).toArray().length;
      if (n) console.log(`  sel ${sel}: ${n}`);
    }
    // sample hrefs containing peliculas
    const links = $('a[href]').toArray()
      .map(el => $(el).attr('href'))
      .filter(h => h && /peliculas|series|ver-/.test(h));
    console.log('  sample links:', [...new Set(links)].slice(0, 8));
    // DLE search feedback markers
    const hasSearch = /do=search|search|búsqueda|resultados/i.test(html);
    console.log('  markers:', { hasSearchWord: hasSearch,
      dleMsg: (html.match(/search%s|search|not found|no se encontr/i) || [])[0]?.slice(0, 40) });
    return html;
  } catch (e) {
    console.log(`\n=== ${label}: FAIL ${String(e?.message || e).slice(0, 120)}`);
    return '';
  }
}

// 1) landing page — what does the live search form look like?
const home = await dump('HOME', 'https://cinehdplus.surf/');
const $h = cheerio.load(home);
$h('form').each((_i, f) => {
  const inputs = $h(f).find('input,select').toArray().map(el => `${el.tagName}[name=${$h(el).attr('name')}]`).join(' ');
  console.log(`FORM action=${$h(f).attr('action')} method=${$h(f).attr('method')}: ${inputs}`);
});
// any JS-driven search endpoint?
const ajax = home.match(/(do=search|subaction=search|\/search[^'"`\s]*|action=[^'"`\s]+)/g);
console.log('JS search hints:', [...new Set(ajax || [])].slice(0, 10));

// 2) POST search "dune" (classic DLE form)
await dump('POST dune', 'https://cinehdplus.surf/index.php?do=search&subaction=search', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'story=dune&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50',
});

// 3) GET search "dune"
await dump('GET dune', 'https://cinehdplus.surf/index.php?do=search&subaction=search&story=dune');

// 4) alt query to confirm query-dependence
await dump('POST perfectos desconocidos', 'https://cinehdplus.surf/index.php?do=search&subaction=search', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'story=perfectos%20desconocidos&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50',
});
