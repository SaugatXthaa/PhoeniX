import { gotScraping } from 'got-scraping';

// The JS says: rn(e, r, t, a) → /api/watch-provider-discovery/${e}?providerId=${r}&region=${t}&genre=${a}
// where e = media ID (tmdb_movie_27205), r = providerId (number), t = region, a = genre

// First, get available watch providers
console.log('=== Available watch providers ===');
const tests = [
  { url: '/api/available-watch-providers/tmdb_movie_27205?region=US', desc: 'US region' },
  { url: '/api/available-watch-providers/tmdb_movie_27205?region=US&section=movie', desc: 'US+section=movie' },
  { url: '/api/available-watch-providers/tmdb_movie_27205?region=US&genre=action', desc: 'US+genre=action' },
  { url: '/api/available-watch-providers/tmdb_movie_27205?region=US&section=movie&genre=action', desc: 'US+section+genre' },
  { url: '/api/available-watch-providers/tmdb_movie_27205?region=IN', desc: 'IN region' },
  { url: '/api/available-watch-providers/tmdb_movie_27205?region=GB', desc: 'GB region' },
  { url: '/api/available-watch-providers/tmdb_movie_27205', desc: 'no params' },
  { url: '/api/available-watch-providers/movie/27205?region=US', desc: 'movie/27205 format' },
  { url: '/api/available-watch-providers/movie/27205', desc: 'movie/27205 no region' },
];

for (const t of tests) {
  const r = await gotScraping(`https://raflixx.vercel.app${t.url}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
    timeout: { request: 8000 }, throwHttpErrors: false,
  });
  if (r.statusCode === 200) {
    const data = JSON.parse(r.body);
    const providers = data.providers || [];
    console.log(`  ${t.desc}: ${r.statusCode} | ${providers.length} providers`);
    if (providers.length > 0) {
      for (const p of providers.slice(0, 5)) {
        console.log(`    provider:`, JSON.stringify(p).slice(0, 200));
      }
      break;
    }
  } else {
    console.log(`  ${t.desc}: ${r.statusCode} | ${r.body.slice(0, 100)}`);
  }
}

// Also test the details endpoint
console.log('\n=== /api/details ===');
const detailsRes = await gotScraping('https://raflixx.vercel.app/api/details/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log('Status:', detailsRes.statusCode, '| size:', detailsRes.body.length);
if (detailsRes.statusCode === 200) {
  const data = JSON.parse(detailsRes.body);
  console.log('Keys:', Object.keys(data));
  console.log('Body:', JSON.stringify(data).slice(0, 1000));
}

// Test the catalog endpoint
console.log('\n=== /api/catalog ===');
const catRes = await gotScraping('https://raflixx.vercel.app/api/catalog', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log('Status:', catRes.statusCode, '| size:', catRes.body.length);
if (catRes.statusCode === 200) {
  console.log('Body:', catRes.body.slice(0, 500));
}

// Test search
console.log('\n=== /api/search ===');
const searchRes = await gotScraping('https://raflixx.vercel.app/api/search?q=inception&scope=movie', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log('Status:', searchRes.statusCode, '| size:', searchRes.body.length);
if (searchRes.statusCode === 200) {
  const data = JSON.parse(searchRes.body);
  console.log('Keys:', Object.keys(data));
  // Look for stream/watch data
  console.log('Body:', JSON.stringify(data).slice(0, 1000));
}
