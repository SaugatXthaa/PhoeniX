// Task 87: full API surface dump — sourceQuality full JSON, series path via sourceEpisodes, cache-hot title E2E
import fs from 'fs';

const OUT = '/home/z/my-project/scripts/task87_acer_full.json';
const dump = {};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': 'https://acermovies.fun',
  'Referer': 'https://acermovies.fun/',
};
const post = (path, body, t = 25000) => fetch(`https://api2.acermovies.fun${path}`, {
  method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(t),
}).then(async r => ({ status: r.status, text: await r.text() }));

// ---- 1. FULL sourceQuality JSON for Inception (fields: uploaded? streamUrl?) ----
const search = await post('/api/search', { searchQuery: 'Inception 2010' });
const searchJ = JSON.parse(search.text);
const postUrl = searchJ.searchResult[0]?.url;
console.log('search:', search.status, 'results:', searchJ.searchResult?.length, 'postUrl:', postUrl);
dump.postUrl = postUrl;

const q = await post('/api/sourceQuality', { url: postUrl });
const qj = JSON.parse(q.text);
console.log('\n===== FULL sourceQuality JSON =====');
console.log(JSON.stringify(qj, null, 1).slice(0, 3500));
dump.sourceQuality = qj;

// ---- 2. sourceUrl per quality entry (movie) — full bodies ----
const movieQs = (qj.sourceQualityList || []).filter(x => x.url);
if (movieQs.length) {
  const su = await post('/api/sourceUrl', { url: movieQs[0].url, seriesType: 'movie' });
  console.log('\nsourceUrl (movie, first quality):', su.status, su.text.slice(0, 200));
  dump.sourceUrlMovie = { status: su.status, body: su.text.slice(0, 300) };
}

// ---- 3. SERIES path: search a series, sourceQuality (episodesUrl entries), sourceEpisodes ----
const sSearch = await post('/api/search', { searchQuery: 'Breaking Bad' });
const sSearchJ = JSON.parse(sSearch.text);
console.log('\nseries search:', sSearch.status, 'results:', sSearchJ.searchResult?.length,
  (sSearchJ.searchResult || []).slice(0, 3).map(x => x.title?.slice(0, 60)));
dump.seriesSearch = sSearchJ.searchResult?.slice(0, 3);

const sPost = (sSearchJ.searchResult || []).find(x => /breaking bad/i.test(x.title || ''))?.url;
if (sPost) {
  const sq = await post('/api/sourceQuality', { url: sPost });
  const sqj = JSON.parse(sq.text);
  const epEntries = (sqj.sourceQualityList || []).filter(x => x.episodesUrl);
  console.log('\nseries sourceQuality:', sq.status, 'entries:', sqj.sourceQualityList?.length,
    'episodesUrl entries:', epEntries.length);
  console.log('episodesUrl sample:', epEntries[0]?.episodesUrl?.slice(0, 120));
  dump.seriesQuality = { entries: sqj.sourceQualityList?.length, epSample: epEntries[0]?.episodesUrl };

  if (epEntries.length) {
    const se = await post('/api/sourceEpisodes', { url: epEntries[0].episodesUrl });
    console.log('\n===== sourceEpisodes response =====');
    console.log(se.status, se.text.slice(0, 600));
    dump.sourceEpisodes = { status: se.status, body: se.text.slice(0, 1200) };

    // try resolving one episode url via sourceUrl seriesType series (guess shapes)
    try {
      const sej = JSON.parse(se.text);
      const firstEp = sej?.episodes?.[0] || sej?.sourceEpisodes?.[0] || (Array.isArray(sej) ? sej[0] : null);
      console.log('firstEp keys:', firstEp ? Object.keys(firstEp) : 'none', JSON.stringify(firstEp || {}).slice(0, 300));
      if (firstEp?.url || firstEp?.episodeUrl) {
        const eu = firstEp.url || firstEp.episodeUrl;
        const sur = await post('/api/sourceUrl', { url: eu, seriesType: 'series' });
        console.log('sourceUrl(series):', sur.status, sur.text.slice(0, 300));
        dump.sourceUrlSeries = { status: sur.status, body: sur.text.slice(0, 400) };
      }
    } catch (e) { console.log('episodes parse fail:', e.message); }
  }
}

// ---- 4. requestOnline shape test (harmless probe — expect validation error, proves endpoint live) ----
const ro = await post('/api/requestOnline/sourceUrl', { url: 'https://invalid.example/x.mp4', imdbId: 'tt1375666', title: 'probe' }, 15000);
console.log('\nrequestOnline probe:', ro.status, ro.text.slice(0, 200));
dump.requestOnline = { status: ro.status, body: ro.text.slice(0, 200) };

fs.writeFileSync(OUT, JSON.stringify(dump, null, 1));
console.log('\nSaved:', OUT);
