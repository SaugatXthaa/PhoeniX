// Test Antova search with different parameter names
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Try different parameter names
const tests = [
  { name: 'query=Jujutsu Kaisen', url: 'https://anilibria.top/api/v1/app/search/releases?query=Jujutsu%20Kaisen&limit=5' },
  { name: 'q=Jujutsu Kaisen', url: 'https://anilibria.top/api/v1/app/search/releases?q=Jujutsu%20Kaisen&limit=5' },
  { name: 'search=Jujutsu Kaisen', url: 'https://anilibria.top/api/v1/app/search/releases?search=Jujutsu%20Kaisen&limit=5' },
  { name: 'query=Jujutsu', url: 'https://anilibria.top/api/v1/app/search/releases?query=Jujutsu&limit=5' },
  { name: 'POST /app/search/releases', url: 'https://anilibria.top/api/v1/app/search/releases', method: 'POST', body: JSON.stringify({ query: 'Jujutsu Kaisen', limit: 5 }) },
];

for (const t of tests) {
  console.log(`\n--- ${t.name} ---`);
  try {
    const opts = {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
    };
    if (t.body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = t.body;
    }
    const r = await gotScraping(t.method === 'POST' ? t.url : t.url, { method: t.method || 'GET', ...opts });
    console.log(`Status: ${r.statusCode} | Body len: ${r.body?.length || 0}`);
    if (r.statusCode === 200) {
      const d = JSON.parse(r.body);
      const list = Array.isArray(d) ? d : (d.data || []);
      console.log(`Results: ${list.length}`);
      for (const item of list.slice(0, 3)) {
        console.log(`  - ${item.alias} | ${item.name?.english || item.name?.main}`);
      }
    } else {
      console.log(`Body: ${r.body?.slice(0, 200)}`);
    }
  } catch (e) { console.log(`ERR: ${e.message}`); }
}
