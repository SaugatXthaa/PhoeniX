// Task 87: E2E test on acer's OWN trending list titles — does their backend resolve those?
import fs from 'fs';

const OUT = '/home/z/my-project/scripts/task87_acer_trending.json';
const dump = { at: new Date().toISOString(), results: [] };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': 'https://acermovies.fun',
  'Referer': 'https://acermovies.fun/',
};
const post = (path, body, t = 25000) => fetch(`https://api2.acermovies.fun${path}`, {
  method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(t),
}).then(async r => ({ status: r.status, text: await r.text() }));

const list = await fetch('https://api2.acermovies.fun/api/list', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
const lj = await list.json();
const trending = (lj.trendingList || []).slice(0, 5);
console.log('trending entries:', (lj.trendingList || []).length);
dump.trendingTitles = trending.map(t => t.title?.slice(0, 60));

for (const entry of trending) {
  const rec = { title: entry.title?.slice(0, 70), post: entry.url?.slice(-60) };
  try {
    const q = await post('/api/sourceQuality', { url: entry.url }, 15000);
    const qj = JSON.parse(q.text);
    rec.qualities = (qj.sourceQualityList || []).length;
    rec.qualityFromCache = qj.fromCache;
    const mu = (qj.sourceQualityList || []).find(x => x.url && !x.episodesUrl);
    if (!mu) { rec.note = 'no movie qualities (series-only post?)'; dump.results.push(rec); console.log(rec.title, '→ no movie qualities'); continue; }
    const su = await post('/api/sourceUrl', { url: mu.url, seriesType: 'movie' }, 25000);
    const sj2 = JSON.parse(su.text);
    rec.fromCache = sj2.fromCache;
    rec.hasUrl = !!sj2.sourceUrl;
    rec.urlHost = sj2.sourceUrl ? new URL(sj2.sourceUrl).host : null;
    rec.sourceUrlMs = 'measured';
    console.log(`${rec.title} → q=${rec.qualities} fromCache=${rec.fromCache} hasUrl=${rec.hasUrl} ${rec.urlHost || ''}`);
    if (sj2.sourceUrl) {
      // HEAD-check the resolved URL (range probe first bytes)
      try {
        const t0 = Date.now();
        const pr = await fetch(sj2.sourceUrl, { method: 'GET', headers: { 'Range': 'bytes=0-3', 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
        const buf = new Uint8Array(await pr.arrayBuffer());
        rec.play = { status: pr.status, ct: pr.headers.get('content-type'), magic: [...buf].map(b => b.toString(16).padStart(2, '0')).join(' '), ms: Date.now() - t0 };
      } catch (e) { rec.play = { error: e.message }; }
    }
  } catch (e) { rec.error = e.message; console.log(rec.title, 'ERR', e.message); }
  dump.results.push(rec);
  fs.writeFileSync(OUT, JSON.stringify(dump, null, 1));
}

const hits = dump.results.filter(r => r.hasUrl);
console.log(`\nTRENDING HITS: ${hits.length}/${dump.results.length}`);
fs.writeFileSync(OUT, JSON.stringify(dump, null, 1));
console.log('Saved:', OUT);
