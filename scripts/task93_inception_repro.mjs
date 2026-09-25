// Task 93: full local repro of FourKHDHubOne for Inception (tmdb:27205) with
// ALL logs captured — including HubCloud liveness-gate drop warnings that the
// /debug/source logs array cannot show (global logger vs source capture).
import { Fetcher } from '../src/utils/Fetcher.js';
import { FourKHDHubOne } from '../src/source/FourKHDHubOne.js';
import { createExtractors, ExtractorRegistry } from '../src/extractor/index.js';
import { ImdbId } from '../src/utils/index.js';

const logs = [];
const logger = {
  log: (...a) => { const l = a.join(' '); logs.push(l); },
  info: (...a) => { logs.push(a.join(' ')); },
  warn: (...a) => { logs.push('WARN: ' + a.join(' ')); },
  error: (...a) => { logs.push('ERR: ' + a.join(' ')); },
  debug: () => {},
};

// also hook console.error (scraper module logs via console.error)
const origCE = console.error;
console.error = (...a) => { logs.push('console.ERR: ' + a.join(' ')); };

const realFetcher = new Fetcher(logger);
// Mock TMDB (no API key in sandbox); real fetcher for everything else
const mockFetcher = {
  json: async (ctx, url, options) => {
    const u = String(url);
    if (u.includes('api.themoviedb.org')) {
      if (u.includes('/find/tt27205')) return { movie_results: [{ id: 27205, title: 'Inception', release_date: '2010-07-15' }], tv_results: [] };
      if (u.includes('/movie/27205')) return { id: 27205, title: 'Inception', release_date: '2010-07-15', imdb_id: 'tt1375666', external_ids: { imdb_id: 'tt1375666' }, original_title: 'Inception' };
    }
    return realFetcher.json(ctx, url, options);
  },
  text: (...a) => realFetcher.text(...a),
  head: (...a) => realFetcher.head(...a),
  get: (...a) => realFetcher.get(...a),
  post: (...a) => realFetcher.post(...a),
};
const fetcher = mockFetcher;
const source = new FourKHDHubOne(mockFetcher);

// Raw source output (raw hubcloud.ist URLs)
console.log('=== running FourKHDHubOne.handleInternal for tmdb:27205 (movie) ===');
const raw = await source.handleInternal({}, 'movie', ImdbId.fromString('tt27205'));
origCE('RAW RESULTS (returned by source):', raw.length);
for (const r of raw) {
  origCE('  raw card:', String(r?.url?.href || r?.url).slice(0, 130), '| title:', String(r?.title || r?.name || '').slice(0, 60));
}

// Now push each raw URL through the extractor registry like StreamResolver does
const extractors = createExtractors(mockFetcher, logger);
const registry = new ExtractorRegistry(logger, extractors);
console.log('=== pushing raw URLs through ExtractorRegistry (liveness gate active) ===');
let finalCount = 0;
for (const r of raw) {
  const u = r?.url?.href || r?.url;
  if (!u) continue;
  try {
    const out = await registry.handle({}, new URL(u), { sourceLabel: '4KHDHub.one', sourceId: '4khdhub' }, true);
    finalCount += out.length;
    origCE(`  registry ${String(u).slice(0, 90)} -> ${out.length} finals`);
    for (const f of out) origCE('     final:', String(f?.url?.href || f?.url).slice(0, 110), '| label:', f?.label || f?.name || '?');
  } catch (e) {
    origCE(`  registry ERROR for ${String(u).slice(0, 90)}:`, e?.message || e);
  }
}
console.log('TOTAL finals after gate:', finalCount);

console.log('=== ALL captured log lines (hubcloud/drop/gate related) ===');
for (const l of logs) {
  if (/hubcloud|drop|dead|gate|pixel/i.test(l)) console.log('  ', l.slice(0, 170));
}
console.error = origCE;
process.exit(0);
