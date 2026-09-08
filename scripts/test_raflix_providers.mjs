import { gotScraping } from 'got-scraping';

// Step 1: Get available watch providers
console.log('=== Watch providers for movie ===');
const provRes = await gotScraping('https://raflixx.vercel.app/api/available-watch-providers/movie?section=movie&region=US', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 8000 }, throwHttpErrors: false,
});
const provData = JSON.parse(provRes.body);
console.log('Providers:', provData.providers?.length);
for (const p of (provData.providers || []).slice(0, 10)) {
  console.log(`  id:${p.id} name:${p.name}`);
}

// Step 2: Test watch-provider-discovery with a provider ID
console.log('\n=== Watch provider discovery ===');
// Try provider ID 8 (Netflix)
const discRes = await gotScraping('https://raflixx.vercel.app/api/watch-provider-discovery/tmdb_movie_27205?providerId=8&region=US&section=movie', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
  timeout: { request: 8000 }, throwHttpErrors: false,
});
console.log('Discovery status:', discRes.statusCode, '| size:', discRes.body.length);
if (discRes.statusCode === 200) {
  const discData = JSON.parse(discRes.body);
  console.log('Keys:', Object.keys(discData));
  console.log('Body:', JSON.stringify(discData).slice(0, 1000));
}

// Step 3: Try different provider IDs (looking for free/streaming providers)
console.log('\n=== Try all provider IDs ===');
for (const p of (provData.providers || [])) {
  const r = await gotScraping(`https://raflixx.vercel.app/api/watch-provider-discovery/tmdb_movie_27205?providerId=${p.id}&region=US&section=movie`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'application/json' },
    timeout: { request: 5000 }, throwHttpErrors: false,
  });
  if (r.statusCode === 200) {
    const data = JSON.parse(r.body);
    if (data.results?.length > 0 || data.url || data.streamUrl || data.embedUrl || data.src) {
      console.log(`  ${p.name} (id:${p.id}): ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
}
