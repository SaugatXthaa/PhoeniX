// Check Naruto Shippuuden episode structure — ordinals might not start at 1
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

const release = await fetchJson(`${API_BASE}/anime/releases/naruto-shippuuden-naruto-uragannye-khroniki`);
console.log(`Title: ${release.name?.english}`);
console.log(`Episodes: ${release.episodes?.length}`);

// Show first 5 and last 5 episode ordinals
const eps = release.episodes || [];
console.log(`\nFirst 5 ordinals:`);
for (const ep of eps.slice(0, 5)) {
  console.log(`  ordinal=${ep.ordinal} | sort_order=${ep.sort_order} | hls_1080=${!!ep.hls_1080} | hls_720=${!!ep.hls_720} | hls_480=${!!ep.hls_480}`);
}
console.log(`\nLast 5 ordinals:`);
for (const ep of eps.slice(-5)) {
  console.log(`  ordinal=${ep.ordinal} | sort_order=${ep.sort_order} | hls_1080=${!!ep.hls_1080} | hls_720=${!!ep.hls_720} | hls_480=${!!ep.hls_480}`);
}

// Check if sort_order starts at 1 while ordinal starts at 370
console.log(`\nsort_order range: ${eps[0]?.sort_order} to ${eps[eps.length-1]?.sort_order}`);
console.log(`ordinal range: ${eps[0]?.ordinal} to ${eps[eps.length-1]?.ordinal}`);

// Get voice team
const voices = (release.members || []).filter(m => m.role?.value === 'voicing').map(m => m.nickname);
console.log(`Voice team: ${voices.join(', ')}`);
