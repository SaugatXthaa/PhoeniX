// Test Antova (AniLiberty) API
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const API_BASE = 'https://anilibria.top/api/v1';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

async function get(path, params) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await gotScraping.get(url.href, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  return { status: r.statusCode, body: r.body };
}

console.log('=== /app/search/releases?query=berserk ===');
let r = await get('/app/search/releases', { query: 'berserk', limit: 5 });
console.log(`Status: ${r.status}`);
if (r.status === 200) {
  const data = JSON.parse(r.body);
  const list = Array.isArray(data) ? data : data.data;
  console.log(`Results: ${list?.length || 0}`);
  for (const item of (list || []).slice(0, 3)) {
    console.log(`  - ${item.alias} (${item.year}) | ${(item.name?.main || '')} | ${(item.name?.english || '')}`);
  }
} else {
  console.log(`Body: ${r.body.slice(0, 500)}`);
}

console.log('\n=== /anime/releases/latest?limit=5 ===');
r = await get('/anime/releases/latest', { limit: 5 });
console.log(`Status: ${r.status}`);
if (r.status === 200) {
  const data = JSON.parse(r.body);
  const list = Array.isArray(data) ? data : (data?.data || []);
  console.log(`Latest: ${list?.length || 0}`);
  for (const item of (list || []).slice(0, 3)) {
    console.log(`  - ${item.alias} (${item.year}) | ${(item.name?.main || '')}`);
  }
  if (list?.[0]?.alias) {
    console.log(`\n=== /anime/releases/${list[0].alias} ===`);
    r = await get(`/anime/releases/${list[0].alias}`);
    console.log(`Status: ${r.status}`);
    if (r.status === 200) {
      const rel = JSON.parse(r.body);
      console.log(`Title: ${rel.name?.main} / ${rel.name?.english}`);
      console.log(`Episodes: ${rel.episodes?.length}`);
      if (rel.episodes?.[0]) {
        const ep = rel.episodes[0];
        console.log(`First episode:`, JSON.stringify({
          ordinal: ep.ordinal,
          sort_order: ep.sort_order,
          duration: ep.duration,
          hls_1080: ep.hls_1080?.slice(0, 80),
          hls_720: ep.hls_720?.slice(0, 80),
          hls_480: ep.hls_480?.slice(0, 80),
        }, null, 2));
      }
    } else {
      console.log(`Body: ${r.body.slice(0, 500)}`);
    }
  }
} else {
  console.log(`Body: ${r.body.slice(0, 500)}`);
}
