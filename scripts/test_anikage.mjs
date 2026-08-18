// Test AniKage API directly
const BASE_URL = 'https://anikage.cc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function apiGet(path) {
  const { gotScraping } = await import('got-scraping');
  const url = path.startsWith('http') ? path : BASE_URL + path;
  const res = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': BASE_URL + '/' },
    timeout: { request: 25000 },
    throwHttpErrors: false,
  });
  console.log(`  GET ${path.slice(0, 80)} -> ${res.statusCode} (${res.body.length} bytes)`);
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch (e) { console.log(`  JSON parse error: ${e.message}`); return null; }
}

async function main() {
  console.log('=== Search for "Demon Slayer" ===');
  const data = await apiGet(`/api/media/anime/browse?q=${encodeURIComponent('Demon Slayer')}`);
  if (!data?.data?.length) {
    console.log('  No results or CF challenge');
    console.log('  Body preview:', JSON.stringify(data).slice(0, 200));
    return;
  }
  console.log(`  ${data.data.length} results:`);
  for (const r of data.data.slice(0, 5)) {
    const titles = [r.title?.english, r.title?.romaji, r.title?.native].filter(Boolean);
    console.log(`    slug="${r.slug}" titles=${JSON.stringify(titles)}`);
  }
}
main().catch(console.error);
