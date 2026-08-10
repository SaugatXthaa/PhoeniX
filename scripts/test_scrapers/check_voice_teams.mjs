// Check if the same anime has multiple releases with different voice teams
// by searching for popular anime and comparing voice teams
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

// Get full detail for Jujutsu Kaisen and check voice team
const releases = ['jujutsu-kaisen', 'jujutsu-kaisen-season-2', 'jujutsu-kaisen-0-movie'];
for (const alias of releases) {
  const r = await fetchJson(`${API_BASE}/anime/releases/${alias}`);
  if (!r) { console.log(`${alias}: not found`); continue; }
  const voices = (r.members || []).filter(m => m.role?.value === 'voicing').map(m => m.nickname);
  const translators = (r.members || []).filter(m => m.role?.value === 'translating').map(m => m.nickname);
  console.log(`${alias}:`);
  console.log(`  English: ${r.name?.english}`);
  console.log(`  Year: ${r.year}`);
  console.log(`  Episodes: ${r.episodes?.length}`);
  console.log(`  Voices: ${voices.join(', ')}`);
  console.log(`  Translators: ${translators.join(', ')}`);
  if (r.episodes?.[0]) {
    console.log(`  First ep ordinal: ${r.episodes[0].ordinal}`);
    console.log(`  First ep HLS: 1080=${!!r.episodes[0].hls_1080} 720=${!!r.episodes[0].hls_720} 480=${!!r.episodes[0].hls_480}`);
  }
  console.log();
}

// Also check Berserk (2016) — it had multiple entries
const berserkResults = await fetchJson(`${API_BASE}/app/search/releases?query=Berserk&limit=10`);
const berserkList = Array.isArray(berserkResults) ? berserkResults : (berserkResults?.data || []);
console.log(`\nBerserk search results: ${berserkList.length}`);
for (const r of berserkList) {
  const detail = await fetchJson(`${API_BASE}/anime/releases/${r.alias}`);
  if (detail) {
    const voices = (detail.members || []).filter(m => m.role?.value === 'voicing').map(m => m.nickname);
    console.log(`  ${r.alias} (${r.year}): voices=[${voices.join(', ')}] eps=${detail.episodes?.length}`);
  }
}
