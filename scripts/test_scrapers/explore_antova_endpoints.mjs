// Explore other Antova API endpoints — look for sources, teams, or multi-language options
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const API_BASE = 'https://anilibria.top/api/v1';

async function fetchJson(url, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = body;
  }
  const res = await gotScraping(url, opts);
  if (res.statusCode !== 200) return { status: res.statusCode, body: res.body?.slice(0, 300) };
  try { return JSON.parse(res.body); } catch { return { parseError: true, body: res.body?.slice(0, 300) }; }
}

// Try various endpoints
const endpoints = [
  '/app/settings',
  '/app/teams',
  '/app/genres',
  '/anime/genres',
  '/anime/teams',
  '/anime/sources',
  '/anime/releases/jujutsu-kaisen/sources',
  '/anime/releases/jujutsu-kaisen/episodes',
  '/anime/releases/jujutsu-kaisen/episodes/1',
  '/anime/episodes/95d6e739-789e-11ec-ae92-0242ac120002',
  '/anime/episodes/95d6e739-789e-11ec-ae92-0242ac120002/sources',
  '/anime/releases/jujutsu-kaisen/voices',
  '/anime/voices',
];

for (const ep of endpoints) {
  console.log(`\n--- ${ep} ---`);
  const r = await fetchJson(`${API_BASE}${ep}`);
  if (r.status) {
    console.log(`  Status: ${r.status} | Body: ${r.body}`);
  } else if (r.parseError) {
    console.log(`  Parse error | Body: ${r.body}`);
  } else {
    const str = JSON.stringify(r);
    console.log(`  OK | length: ${str.length}`);
    console.log(`  Preview: ${str.slice(0, 500)}`);
  }
}

// Also check the /anime/releases/{alias} response for "members" field
// which might list different voice actors / dub teams
console.log('\n\n=== Check release members/sponsors fields ===');
const release = await fetchJson(`${API_BASE}/anime/releases/jujutsu-kaisen`);
if (release && !release.status) {
  console.log('Members:', JSON.stringify(release.members)?.slice(0, 500));
  console.log('Sponsors:', JSON.stringify(release.sponsors)?.slice(0, 500));
  console.log('Team:', JSON.stringify(release.team)?.slice(0, 500));
  // Check if episodes have more data when fetched individually
  if (release.episodes?.[0]) {
    console.log('\nFirst episode ID:', release.episodes[0].id);
    const epDetail = await fetchJson(`${API_BASE}/anime/episodes/${release.episodes[0].id}`);
    if (epDetail && !epDetail.status) {
      console.log('Episode detail keys:', Object.keys(epDetail).join(', '));
      console.log('Episode detail:', JSON.stringify(epDetail).slice(0, 1000));
    } else {
      console.log('Episode detail fetch failed:', epDetail?.status, epDetail?.body);
    }
  }
}
