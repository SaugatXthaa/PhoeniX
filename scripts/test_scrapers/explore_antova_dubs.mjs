// Check if multiple AniLibria releases exist for the same anime with different dubs
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

// Search for popular anime and check all results
const searches = ['Naruto', 'One Piece', 'Attack on Titan', 'Bleach', 'My Hero Academia', 'Tokyo Ghoul'];

for (const query of searches) {
  console.log(`\n=== Search: ${query} ===`);
  const data = await fetchJson(`${API_BASE}/app/search/releases?query=${encodeURIComponent(query)}&limit=20`);
  const results = Array.isArray(data) ? data : (data?.data || []);
  console.log(`Results: ${results.length}`);
  for (const r of results.slice(0, 8)) {
    const members = (r.members || []).filter(m => m.role?.value === 'voicing').map(m => m.nickname).join(', ');
    console.log(`  - ${r.alias} | ${r.name?.english} | ${r.year} | voices: ${members || 'none'}`);
  }
}

// Get full detail for a popular release and check if there are multiple dub versions
console.log('\n\n=== Full detail for naruto-shippuuden-naruto-uragannye-khroniki ===');
const release = await fetchJson(`${API_BASE}/anime/releases/naruto-shippuuden-naruto-uragannye-khroniki`);
if (release) {
  console.log(`Title: ${release.name?.english}`);
  console.log(`Episodes: ${release.episodes?.length}`);
  console.log(`Members: ${JSON.stringify(release.members)?.slice(0, 500)}`);

  // Check first episode
  if (release.episodes?.[0]) {
    const ep = release.episodes[0];
    console.log(`\nFirst episode:`);
    console.log(`  ordinal: ${ep.ordinal}`);
    console.log(`  hls_480: ${ep.hls_480?.slice(0, 80)}`);
    console.log(`  hls_720: ${ep.hls_720?.slice(0, 80)}`);
    console.log(`  hls_1080: ${ep.hls_1080?.slice(0, 80)}`);
    // Check for any other fields that might indicate alternate audio
    console.log(`  all keys: ${Object.keys(ep).join(', ')}`);
  }
}

// Check if there's a "code" or "id" based lookup that returns different versions
console.log('\n\n=== Check for alternate releases of the same anime ===');
// Search for "Tokyo Ghoul" — might have multiple versions (subbed, dubbed, etc.)
const tgData = await fetchJson(`${API_BASE}/app/search/releases?query=Tokyo%20Ghoul&limit=20`);
const tgResults = Array.isArray(tgData) ? tgData : (tgData?.data || []);
console.log(`Tokyo Ghoul results: ${tgResults.length}`);
for (const r of tgResults) {
  console.log(`  - ${r.alias} | ${r.name?.english} | ${r.year}`);
  // Get full detail to check for alternate audio
  const detail = await fetchJson(`${API_BASE}/anime/releases/${r.alias}`);
  if (detail?.episodes?.[0]) {
    const ep = detail.episodes[0];
    const hasHls = !!(ep.hls_480 || ep.hls_720 || ep.hls_1080);
    console.log(`    episodes: ${detail.episodes.length} | has HLS: ${hasHls}`);
    const voices = (detail.members || []).filter(m => m.role?.value === 'voicing').map(m => m.nickname);
    console.log(`    voices: ${voices.join(', ')}`);
  }
}
