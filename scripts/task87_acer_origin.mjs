// Task 87: enumerate acermovies.fun ORIGIN /api/* routes (the site's own server-side surface)
import fs from 'fs';

const OUT = '/home/z/my-project/scripts/task87_acer_origin.json';
const dump = {};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': 'https://acermovies.fun',
  'Referer': 'https://acermovies.fun/',
};
const post = (path, body, t = 25000) => fetch(`https://acermovies.fun${path}`, {
  method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(t),
}).then(async r => ({ status: r.status, ct: r.headers.get('content-type'), text: await r.text() }));

// 1. site-origin search proxy?
const s1 = await post('/api/search', { searchQuery: 'Inception 2010' });
console.log('origin /api/search:', s1.status, s1.ct, '|', s1.text.slice(0, 150));
dump.originSearch = { status: s1.status, body: s1.text.slice(0, 200) };

// 2. site-origin sourceQuality proxy?
const s2 = await post('/api/sourceQuality', { url: 'https://moviesmod.ai.in/download-inception-2010-hindi-480p-720p-1080p/' });
console.log('origin /api/sourceQuality:', s2.status, '|', s2.text.slice(0, 150));
dump.originQuality = { status: s2.status, body: s2.text.slice(0, 200) };

// 3. site-origin sourceUrl proxy?
const s3 = await post('/api/sourceUrl', { url: 'https://links.modpro.blog/archives/5787', seriesType: 'movie' });
console.log('origin /api/sourceUrl:', s3.status, '|', s3.text.slice(0, 200));
dump.originSourceUrl = { status: s3.status, body: s3.text.slice(0, 250) };

// 4. site-origin sourceEpisodes proxy?
const s4 = await post('/api/sourceEpisodes', { url: 'https://episodes.modpro.blog/archives/61063' });
console.log('origin /api/sourceEpisodes:', s4.status, '|', s4.text.slice(0, 200));
dump.originEpisodes = { status: s4.status, body: s4.text.slice(0, 250) };

// 5. requestOnline on ORIGIN (with placeholder — expect JSON error, not 404-html, if route exists)
const s5 = await post('/api/requestOnline/sourceUrl', { url: 'https://invalid.example/x.mp4', imdbId: 'tt1375666', title: 'probe' });
console.log('origin /api/requestOnline/sourceUrl:', s5.status, '|', s5.text.slice(0, 200));
dump.originRequestOnline = { status: s5.status, body: s5.text.slice(0, 250) };

// 6. api/list on origin
const s6 = await post('/api/list', { imdbId: 'tt1375666' }).catch(e => ({ status: 0, text: e.message }));
console.log('origin /api/list:', s6.status, '|', String(s6.text).slice(0, 200));
dump.originList = { status: s6.status, body: String(s6.text).slice(0, 250) };

// 7. cache-hot hunt: try a few hot titles, look for any sourceUrl fromCache:true
for (const title of ['Pushpa 2 2024', 'Deadpool Wolverine 2024', 'Stree 2 2024', 'Venom The Last Dance 2024']) {
  try {
    const sr = await post('/api/search', { searchQuery: title }, 15000);
    const sj = JSON.parse(sr.text);
    const hit = (sj.searchResult || [])[0];
    if (!hit?.url) { console.log(`hot "${title}": no results`); continue; }
    const q = await post('/api/sourceQuality', { url: hit.url }, 15000);
    const qj = JSON.parse(q.text);
    const mu = (qj.sourceQualityList || []).find(x => x.url && !x.episodesUrl);
    if (!mu) { console.log(`hot "${title}": no movie qualities`); continue; }
    const su = await post('/api/sourceUrl', { url: mu.url, seriesType: 'movie' }, 20000);
    const sj2 = JSON.parse(su.text);
    console.log(`hot "${title}": sourceUrl fromCache=${sj2.fromCache} hasUrl=${!!sj2.sourceUrl} ${sj2.sourceUrl ? sj2.sourceUrl.slice(0, 80) : ''}`);
    dump.hot = dump.hot || [];
    dump.hot.push({ title, fromCache: sj2.fromCache, hasUrl: !!sj2.sourceUrl, url: (sj2.sourceUrl || '').slice(0, 100) });
    if (sj2.sourceUrl) break;
  } catch (e) { console.log(`hot "${title}" err:`, e.message); }
}

fs.writeFileSync(OUT, JSON.stringify(dump, null, 1));
console.log('\nSaved:', OUT);
