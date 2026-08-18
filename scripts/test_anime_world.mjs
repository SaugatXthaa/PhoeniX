// Mimic AnimeWorld source's findAnime to see what it parses
const { gotScraping } = await import('got-scraping');

const BASE_URL = 'https://watchanimeworld.top';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const normalize = (s) => (s || '').toLowerCase()
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

const buildQueries = (title) => {
  const queries = [title];
  const colonIdx = title.indexOf(':');
  if (colonIdx > 0) {
    const main = title.substring(0, colonIdx).trim();
    if (main) queries.push(main);
    const joined = title.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    if (joined && joined !== title) queries.push(joined);
  }
  return [...new Set(queries.filter(Boolean))];
};

async function fetchPage(url) {
  try {
    const res = await gotScraping.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      timeout: { request: 15000 },
      throwHttpErrors: false,
      followRedirect: true,
    });
    console.log(`  fetchPage ${url.slice(0, 80)} -> ${res.statusCode} (${res.body.length} chars)`);
    return res.statusCode === 200 ? res.body : null;
  } catch (e) {
    console.log(`  fetchPage error: ${e.message}`);
    return null;
  }
}

async function main() {
  const name = 'Demon Slayer: Kimetsu no Yaiba';
  const wantedType = 'series';
  const queries = buildQueries(name);
  console.log('Queries:', queries);

  for (const query of queries) {
    console.log(`\n=== Query: "${query}" ===`);
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    const html = await fetchPage(searchUrl);
    if (!html) {
      console.log('  no html, continue');
      continue;
    }

    // Find all series/movies links
    const re = new RegExp(`${BASE_URL.replace(/\./g, '\\.')}/(series|movies)/([^/?#]+)/?`, 'g');
    const matches = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      matches.push({ url: m[0], type: m[1], slug: m[2] });
    }
    console.log(`  regex matches: ${matches.length}`);
    // Show unique slugs
    const unique = [...new Map(matches.map(m => [m.slug, m])).values()];
    console.log(`  unique slugs: ${unique.length}`);
    for (const u of unique.slice(0, 8)) {
      console.log(`    ${u.type}/${u.slug}`);
    }
  }
}

main().catch(console.error);
