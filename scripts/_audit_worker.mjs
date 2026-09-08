// Audit worker — runs ONE source test in isolation.
// Called by audit_all_sources_live.mjs via child_process.
//
// Usage: node scripts/_audit_worker.mjs <sourceId> <testCaseJson>
// Output: single JSON line on stdout: { ok, count, elapsed, sample, error }

// Redirect console.log (debug output) to stderr so it doesn't pollute stdout.
// The audit script parses the LAST line of stdout as JSON.
const origLog = console.log;
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
const origInfo = console.info;
console.info = (...args) => process.stderr.write(args.join(' ') + '\n');
const origWarn = console.warn;
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// Use the REAL Fetcher (not a mock) so sources that call this.fetcher.text()
// work correctly. The Fetcher handles HTTP requests, cookies, redirects, etc.
const { Fetcher } = await import(path.join(PROJECT_ROOT, 'src', 'utils', 'Fetcher.js'));
const realFetcher = new Fetcher(console);

// Wrap json() to intercept TMDB calls (so we don't hit the real TMDB API
// and rate-limit). All other requests (scraper HTML/API calls) go through
// the real Fetcher.
const mockFetcher = {
  json: async (ctx, url, options) => {
    const urlStr = url.toString();
    // TMDB API calls — return mock data
    if (urlStr.includes('api.themoviedb.org')) {
      if (urlStr.includes('/movie/')) {
        if (urlStr.includes('/693134')) return { title: 'Dune: Part Two', release_date: '2024-02-27', imdb_id: 'tt15239678', external_ids: { imdb_id: 'tt15239678' }, genres: [{ id: 878, name: 'Sci-Fi' }], original_language: 'en' };
        if (urlStr.includes('/372058')) return { title: 'Your Name', release_date: '2016-08-26', imdb_id: 'tt5311514', external_ids: { imdb_id: 'tt5311514' }, genres: [{ id: 16, name: 'Animation' }], original_language: 'ja' };
        if (urlStr.includes('/27205')) return { title: 'Inception', release_date: '2010-07-15', imdb_id: 'tt1375666', external_ids: { imdb_id: 'tt1375666' }, genres: [{ id: 878, name: 'Sci-Fi' }], original_language: 'en' };
        return { title: 'Test Movie', release_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/tv/')) {
        if (urlStr.includes('/31910')) return { name: 'Naruto', first_air_date: '2002-10-03', imdb_id: 'tt0988824', external_ids: { imdb_id: 'tt0988824' }, genres: [{ id: 16, name: 'Animation' }], original_language: 'ja' };
        if (urlStr.includes('/1396')) return { name: 'Breaking Bad', first_air_date: '2008-01-20', imdb_id: 'tt0903747', external_ids: { imdb_id: 'tt0903747' }, genres: [{ id: 18, name: 'Drama' }], original_language: 'en' };
        return { name: 'Test Show', first_air_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/find/')) {
        if (urlStr.includes('tt15239678')) return { movie_results: [{ id: 693134 }] };
        if (urlStr.includes('tt5311514')) return { movie_results: [{ id: 372058 }] };
        if (urlStr.includes('tt1375666')) return { movie_results: [{ id: 27205 }] };
        if (urlStr.includes('tt0988824')) return { tv_results: [{ id: 31910 }] };
        if (urlStr.includes('tt0903747')) return { tv_results: [{ id: 1396 }] };
        return { movie_results: [], tv_results: [] };
      }
    }
    if (urlStr.includes('providers.json')) return {};
    // Non-TMDB JSON calls — use real fetcher
    return realFetcher.json(ctx, url, options);
  },
  // All other methods delegate to real fetcher
  text: (ctx, url, options) => realFetcher.text(ctx, url, options),
  textPost: (ctx, url, data, options) => realFetcher.textPost(ctx, url, data, options),
  head: (ctx, url, options) => realFetcher.head(ctx, url, options),
  fetch: (ctx, url, options) => realFetcher.fetch(ctx, url, options),
  getFinalRedirectUrl: (ctx, url, options, maxCount, count) => realFetcher.getFinalRedirectUrl(ctx, url, options, maxCount, count),
  setCookie: (url, cookieString) => realFetcher.setCookie(url, cookieString),
};

const { createSources } = await import(path.join(PROJECT_ROOT, 'src', 'source', 'index.js'));
const sources = createSources(mockFetcher);
const source = sources.find(s => s.id === process.argv[2]);
if (!source) { console.error('Source not found: ' + process.argv[2]); process.exit(2); }

const testCase = JSON.parse(process.argv[3]);
const timeoutMs = parseInt(process.argv[4]) || 48000;
const ctx = { hostUrl: 'http://localhost:11470' };
const id = { id: testCase.tmdbId, ...(testCase.season ? { season: testCase.season, episode: testCase.episode } : {}) };

try {
  const t0 = Date.now();
  const results = await Promise.race([
    source.handleInternal(ctx, testCase.type, id),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
  ]);
  const elapsed = Date.now() - t0;
  const count = Array.isArray(results) ? results.length : 0;
  const sample = count > 0 ? (results[0].url?.href || results[0].url || '').slice(0, 100) : '';
  // Use process.stdout.write (not console.log) to ensure JSON goes to stdout
  process.stdout.write(JSON.stringify({ ok: true, count, elapsed, sample }) + '\n');
  // Force exit — some scrapers leave pending HTTPS/got-scraping handles open
  // that prevent the Node process from exiting cleanly.
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, elapsed: 0 }) + '\n');
  process.exit(0);
}
