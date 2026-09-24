// Task 87: cache-hot hunt against api2 + fromCache timing + modpro DC check
import fs from 'fs';

const OUT = '/home/z/my-project/scripts/task87_acer_hot.json';
const dump = { at: new Date().toISOString(), titles: [] };
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

// Sept 2026 "hot" candidates: 2025-2026 releases across hindi/hollywood
const TITLES = [
  'Saiyaara 2025', 'War 2 2025', 'Coolie 2025', 'Chhaava 2025',
  'Superman 2025', 'F1 2025', 'Jurassic World Rebirth 2025', 'Lilo Stitch 2025',
  'Raid 2 2025', 'Housefull 5 2025', 'Sitaare Zameen Par 2025', 'Mahavatar Narsimha 2025',
];

for (const title of TITLES) {
  const rec = { title };
  try {
    const t0 = Date.now();
    const sr = await post('/api/search', { searchQuery: title }, 15000);
    rec.searchMs = Date.now() - t0;
    rec.searchStatus = sr.status;
    const sj = JSON.parse(sr.text);
    const hit = (sj.searchResult || [])[0];
    if (!hit?.url) { rec.note = 'no results'; dump.titles.push(rec); console.log(title, '→ no results'); continue; }
    rec.postTitle = hit.title?.slice(0, 70);

    const q = await post('/api/sourceQuality', { url: hit.url }, 15000);
    const qj = JSON.parse(q.text);
    rec.qualityFromCache = qj.fromCache;
    rec.qualities = (qj.sourceQualityList || []).filter(x => x.url && !x.episodesUrl).length;

    const mu = (qj.sourceQualityList || []).find(x => x.url && !x.episodesUrl);
    if (!mu) { rec.note = 'no movie qualities'; dump.titles.push(rec); console.log(title, '→ no qualities'); continue; }

    const t1 = Date.now();
    const su = await post('/api/sourceUrl', { url: mu.url, seriesType: 'movie' }, 20000);
    rec.sourceUrlMs = Date.now() - t1;
    const sj2 = JSON.parse(su.text);
    rec.fromCache = sj2.fromCache;
    rec.hasUrl = !!sj2.sourceUrl;
    rec.urlHost = sj2.sourceUrl ? new URL(sj2.sourceUrl).host : null;
    console.log(`${title} → ${rec.postTitle} | q=${rec.qualities} sourceUrl fromCache=${rec.fromCache} hasUrl=${rec.hasUrl} (${rec.sourceUrlMs}ms) ${rec.urlHost || ''}`);
    if (rec.hasUrl) rec.sourceUrl = sj2.sourceUrl.slice(0, 120);
  } catch (e) { rec.error = e.message; console.log(title, 'ERR', e.message); }
  dump.titles.push(rec);
  fs.writeFileSync(OUT, JSON.stringify(dump, null, 1));
}

const hits = dump.titles.filter(t => t.hasUrl);
console.log(`\nHITS: ${hits.length}/${dump.titles.length}`);
for (const h of hits) console.log(' ', h.title, '→', h.urlHost, h.sourceUrl?.slice(0, 90));

// modpro direct check (DC egress) — is the direct chain still viable?
try {
  const t0 = Date.now();
  const r = await fetch('https://links.modpro.blog/archives/5787', {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000), redirect: 'follow',
  });
  const body = await r.text();
  dump.modpro = { status: r.status, ms: Date.now() - t0, len: body.length, hasDrive: /drive|googleusercontent|hubcloud|gdflix/i.test(body) };
  console.log('\nmodpro direct:', JSON.stringify(dump.modpro));
} catch (e) { dump.modpro = { error: e.message }; console.log('\nmodpro direct ERR:', e.message); }

fs.writeFileSync(OUT, JSON.stringify(dump, null, 1));
console.log('Saved:', OUT);
