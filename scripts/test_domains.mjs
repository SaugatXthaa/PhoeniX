import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function probe(url, label) {
  try {
    const r = await gotScraping.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' },
      timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`${label}: status=${r.statusCode} len=${r.body.length}`);
    if (r.statusCode !== 200 || r.body.length < 500) {
      const title = (r.body.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
      console.log(`  title="${title}" sample="${r.body.slice(0, 150).replace(/\n/g, ' ')}"`);
    }
  } catch (e) {
    console.log(`${label}: ERR ${e.code || e.message.slice(0, 80)}`);
  }
}

console.log('=== Testing all broken source upstream domains ===');
await Promise.all([
  probe('https://anineko.to/', 'anineko.to'),
  probe('https://anikage.cc/', 'anikage.cc'),
  probe('https://anivault-api.up.railway.app/api/anime/search?query=naruto', 'anivault-api'),
  probe('https://hdghartv.cc/api/search?q=inception', 'hdghartv.cc'),
  probe('https://animesalt.link/', 'animesalt.link'),
  probe('https://watchanimeworld.top/', 'watchanimeworld.top'),
  probe('https://play.zephyrix.top/', 'play.zephyrix.top'),
  probe('https://nikastream.blog/', 'nikastream.blog'),
  probe('https://anivexa-api.sudeepdon119.workers.dev/episodes/anikoto/21', 'anivexa-api'),
  probe('https://vidbolt.xyz/api/proxy?path=%2Fscrape%2FVidRock%2Fmovie%2F27205%3FtmdbId%3D27205%26title%3DInception%26year%3D2010', 'vidbolt-api'),
  probe('https://stellar.gdn/', 'stellar.gdn'),
  probe('https://api.stellar.gdn/api/challenge', 'api.stellar.gdn'),
  probe('https://stellar.rip/', 'stellar.rip'),
  probe('https://cinefreak.net/?s=inception', 'cinefreak.net'),
]);
