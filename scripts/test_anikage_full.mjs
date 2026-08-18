// Mimic AniKage source's findSlug exactly to find what's failing
const BASE_URL = 'https://anikage.cc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function apiGet(path, referer = BASE_URL + '/') {
  const { gotScraping } = await import('got-scraping');
  const url = path.startsWith('http') ? path : BASE_URL + path;
  const res = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': referer },
    timeout: { request: 25000 },
    throwHttpErrors: false,
  });
  console.log(`  apiGet ${path.slice(0, 70)} -> ${res.statusCode} (${res.body.length} chars)`);
  if (res.statusCode !== 200) {
    console.log(`  body preview: ${res.body.slice(0, 200)}`);
    return null;
  }
  try { return JSON.parse(res.body); } catch (e) { console.log(`  JSON parse error: ${e.message}`); return null; }
}

async function main() {
  const name = 'Demon Slayer: Kimetsu no Yaiba';
  const queries = [
    name,
    name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
  ].filter((q, i, arr) => q && arr.indexOf(q) === i);

  console.log('Queries:', queries);

  const nameNorm = normalize(name);
  console.log('nameNorm:', nameNorm);

  for (const query of queries) {
    console.log(`\n--- Trying query: "${query}" ---`);
    const data = await apiGet(`/api/media/anime/browse?q=${encodeURIComponent(query)}`);
    if (!data?.data?.length) {
      console.log('  No data, continue');
      continue;
    }
    console.log(`  ${data.data.length} results:`);
    let best = null;
    let bestScore = 0;
    for (const r of data.data) {
      const titles = [r.title?.english, r.title?.romaji, r.title?.native, r.title?.userPreferred].filter(Boolean);
      for (const t of titles) {
        const tNorm = normalize(t);
        if (!tNorm) continue;
        let score = 0;
        if (tNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        }
        if (score > bestScore) {
          bestScore = score;
          best = r;
          console.log(`    NEW BEST: score=${score.toFixed(1)} title="${t}" slug="${r.slug}"`);
        }
      }
    }
    if (best && bestScore >= 60) {
      console.log(`  MATCH: slug="${best.slug}" (score=${bestScore.toFixed(1)})`);
      return best.slug;
    }
    console.log(`  No match above threshold (best score ${bestScore.toFixed(1)})`);
  }
  console.log('\nNo match found');
}
main().catch(console.error);
