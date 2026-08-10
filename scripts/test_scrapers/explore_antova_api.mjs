// Explore the full Antova API response to find all available sub/dub sources
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const API_BASE = 'https://anilibria.top/api/v1';

async function fetchJson(url) {
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// Search for Jujutsu Kaisen
const searchData = await fetchJson(`${API_BASE}/app/search/releases?query=Jujutsu%20Kaisen&limit=10`);
const results = Array.isArray(searchData) ? searchData : (searchData?.data || []);
console.log(`Search results: ${results.length}`);
for (const r of results.slice(0, 5)) {
  console.log(`  - ${r.alias} | ${r.name?.english} | ${r.year}`);
}

// Get the full release detail for the first match
if (results[0]) {
  const alias = results[0].alias;
  console.log(`\n=== Full release detail for ${alias} ===`);
  const release = await fetchJson(`${API_BASE}/anime/releases/${alias}`);
  if (!release) { console.log('Failed'); process.exit(0); }

  // Print top-level keys
  console.log('Top-level keys:', Object.keys(release).join(', '));

  // Check if there's a "voices" or "translations" field
  if (release.voices) console.log('Voices:', JSON.stringify(release.voices).slice(0, 500));
  if (release.translations) console.log('Translations:', JSON.stringify(release.translations).slice(0, 500));
  if (release.team) console.log('Team:', JSON.stringify(release.team).slice(0, 500));

  // Print first episode structure
  if (release.episodes?.[0]) {
    const ep = release.episodes[0];
    console.log('\n=== First episode keys:', Object.keys(ep).join(', '));
    console.log('Ordinal:', ep.ordinal);
    console.log('Duration:', ep.duration);

    // Check for HLS fields
    for (const key of Object.keys(ep)) {
      if (key.startsWith('hls') || key.includes('stream') || key.includes('video') || key.includes('audio')) {
        const val = ep[key];
        console.log(`  ${key}: ${typeof val === 'string' ? val.slice(0, 120) : JSON.stringify(val).slice(0, 200)}`);
      }
    }

    // Check for "voices" or "teams" inside episode
    if (ep.voices) console.log('  Episode voices:', JSON.stringify(ep.voices).slice(0, 500));
    if (ep.translations) console.log('  Episode translations:', JSON.stringify(ep.translations).slice(0, 500));
    if (ep.fandub) console.log('  Episode fandub:', JSON.stringify(ep.fandub).slice(0, 500));
    if (ep.dubs) console.log('  Episode dubs:', JSON.stringify(ep.dubs).slice(0, 500));
  }

  // Dump the full first episode as JSON for analysis
  console.log('\n=== Full first episode JSON ===');
  console.log(JSON.stringify(release.episodes?.[0], null, 2).slice(0, 3000));
}
