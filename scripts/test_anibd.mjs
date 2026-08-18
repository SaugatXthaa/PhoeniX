// Test AniBD API directly — search for Demon Slayer
const SEARCH_API = 'https://eng.animeapps.top/api/search3.php';
const EPISODES_API = 'https://epeng.animeapps.top/api2.php';
const APILINK_API = 'https://epeng.animeapps.top/apilink.php';
const PLAYENG_BASE = 'https://playeng.animeapps.top/r2/cachehd';
const BASE_URL = 'https://anibd.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function got(url, opts = {}) {
  const { gotScraping } = await import('got-scraping');
  return gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': BASE_URL + '/', ...opts.headers },
    timeout: { request: 15000 },
    throwHttpErrors: false,
    ...opts,
  });
}

async function main() {
  // Step 1: Search
  console.log('=== Step 1: Search for "Demon Slayer" ===');
  const r1 = await got(`${SEARCH_API}?keyword=${encodeURIComponent('Demon Slayer')}`);
  console.log('  Status:', r1.statusCode);
  if (r1.statusCode !== 200) return;
  const data1 = JSON.parse(r1.body);
  console.log('  Results:', data1.data?.length || 0);
  if (data1.data?.length > 0) {
    console.log('  First 5:');
    for (const r of data1.data.slice(0, 5)) {
      console.log(`    postid=${r.postid} anilist=${r.anilist} postname="${r.postname}" postyear=${r.postyear}`);
    }
  }

  // Step 2: Get episodes for first match's anilist ID
  if (data1.data?.length > 0) {
    const anilistId = data1.data[0].anilist;
    console.log(`\n=== Step 2: Get episodes for anilist=${anilistId} ===`);
    const r2 = await got(`${EPISODES_API}?epid=${anilistId}`);
    console.log('  Status:', r2.statusCode);
    if (r2.statusCode === 200) {
      const data2 = JSON.parse(r2.body);
      console.log('  Servers:', Array.isArray(data2) ? data2.length : 'not array');
      if (Array.isArray(data2) && data2.length > 0) {
        const srv = data2[0];
        console.log(`  server_name: ${srv.server_name}`);
        console.log(`  server_data length: ${srv.server_data?.length || 0}`);
        if (srv.server_data?.length > 0) {
          console.log(`  First 3 episodes:`);
          for (const ep of srv.server_data.slice(0, 3)) {
            console.log(`    name=${ep.name} link=${ep.link?.slice(0, 60)}`);
          }
        }
      }
    }
  }
}
main().catch(console.error);
