// Test AniBD API - dump all fields
const SEARCH_API = 'https://eng.animeapps.top/api/search3.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const { gotScraping } = await import('got-scraping');
  const r = await gotScraping.get(`${SEARCH_API}?keyword=${encodeURIComponent('Demon Slayer')}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://anibd.app/' },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  const data = JSON.parse(r.body);
  console.log('Full first result:');
  console.log(JSON.stringify(data.data[0], null, 2));
  console.log();
  console.log('All results (postname + english + romaji):');
  for (const r of data.data) {
    console.log(`  postname="${r.postname}" english="${r.english || 'N/A'}" romaji="${r.romaji || 'N/A'}" postyear=${r.postyear} anilist=${r.anilist}`);
  }
}
main().catch(console.error);
