// Test Antova with popular anime titles to verify fuzzy matching
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const API_BASE = 'https://anilibria.top/api/v1';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

async function search(query) {
  const url = `${API_BASE}/app/search/releases?query=${encodeURIComponent(query)}&limit=10`;
  const r = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (r.statusCode !== 200) return [];
  try {
    const d = JSON.parse(r.body);
    return Array.isArray(d) ? d : (d.data || []);
  } catch { return []; }
}

async function getRelease(alias) {
  const r = await gotScraping.get(`${API_BASE}/anime/releases/${alias}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (r.statusCode !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

// Try various queries — note the API uses "query" not "q"
const QUERIES = [
  'Berserk',
  'Jujutsu Kaisen',
  'Attack on Titan',
  'Demon Slayer',
  'One Piece',
  'Naruto',
  'Death Note',
  'Fullmetal Alchemist',
  'My Hero Academia',
  'Chainsaw Man',
  'Spy x Family',
  'Vinland Saga',
];

for (const q of QUERIES) {
  const results = await search(q);
  console.log(`\n${q}: ${results.length} results`);
  for (const r of results.slice(0, 3)) {
    console.log(`  - ${r.alias} (${r.year}) | ${r.name?.main} / ${r.name?.english}`);
  }
  // Get the first result to verify it has streams
  if (results[0]) {
    const rel = await getRelease(results[0].alias);
    if (rel?.episodes?.[0]) {
      const ep = rel.episodes[0];
      const hasStreams = !!(ep.hls_1080 || ep.hls_720 || ep.hls_480);
      console.log(`  → First release has ${rel.episodes.length} episodes | ep1 streams: ${hasStreams}`);
      if (ep.hls_1080) console.log(`    1080p: ${ep.hls_1080.slice(0, 80)}...`);
    }
  }
}
