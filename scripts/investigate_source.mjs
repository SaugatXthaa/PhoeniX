// Investigate each failing source with FULL verbose output (stderr visible).
// Tests each source individually to understand WHY it returns 0 streams.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROJECT_ROOT = path.join(__dirname, '..');

const { Fetcher } = await import(path.join(PROJECT_ROOT, 'src', 'utils', 'Fetcher.js'));
const realFetcher = new Fetcher(console);

const mockFetcher = {
  json: async (ctx, url, options) => {
    const urlStr = url.toString();
    if (urlStr.includes('api.themoviedb.org')) {
      if (urlStr.includes('/movie/')) {
        if (urlStr.includes('/693134')) return { title: 'Dune: Part Two', release_date: '2024-02-27', imdb_id: 'tt15239678', external_ids: { imdb_id: 'tt15239678' }, genres: [{ id: 878, name: 'Sci-Fi' }], original_language: 'en' };
        if (urlStr.includes('/372058')) return { title: 'Your Name', release_date: '2016-08-26', imdb_id: 'tt5311514', external_ids: { imdb_id: 'tt5311514' }, genres: [{ id: 16, name: 'Animation' }], original_language: 'ja' };
        if (urlStr.includes('/27205')) return { title: 'Inception', release_date: '2010-07-15', imdb_id: 'tt1375666', external_ids: { imdb_id: 'tt1375666' }, genres: [{ id: 878 }], original_language: 'en' };
        if (urlStr.includes('/558')) return { title: 'Spider-Man 2', release_date: '2004-06-25', imdb_id: 'tt0316654', external_ids: { imdb_id: 'tt0316654' }, genres: [{ id: 28 }, { id: 878 }], original_language: 'en' };
        return { title: 'Test Movie', release_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/tv/')) {
        if (urlStr.includes('/31910')) return { name: 'Naruto', first_air_date: '2002-10-03', imdb_id: 'tt0988824', external_ids: { imdb_id: 'tt0988824' }, genres: [{ id: 16, name: 'Animation' }], original_language: 'ja', number_of_seasons: 5, number_of_episodes: 220 };
        if (urlStr.includes('/1396')) return { name: 'Breaking Bad', first_air_date: '2008-01-20', imdb_id: 'tt0903747', external_ids: { imdb_id: 'tt0903747' }, genres: [{ id: 18, name: 'Drama' }], original_language: 'en', number_of_seasons: 5, number_of_episodes: 62 };
        if (urlStr.includes('/37854')) return { name: 'One Piece', first_air_date: '1999-10-20', imdb_id: 'tt0388629', external_ids: { imdb_id: 'tt0388629' }, genres: [{ id: 16 }, { id: 10759 }], original_language: 'ja', number_of_seasons: 21, number_of_episodes: 1080 };
        return { name: 'Test Show', first_air_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/find/')) {
        if (urlStr.includes('tt15239678')) return { movie_results: [{ id: 693134 }] };
        if (urlStr.includes('tt5311514')) return { movie_results: [{ id: 372058 }] };
        if (urlStr.includes('tt1375666')) return { movie_results: [{ id: 27205 }] };
        if (urlStr.includes('tt0316654')) return { movie_results: [{ id: 558 }] };
        if (urlStr.includes('tt0988824')) return { tv_results: [{ id: 31910 }] };
        if (urlStr.includes('tt0903747')) return { tv_results: [{ id: 1396 }] };
        if (urlStr.includes('tt0388629')) return { tv_results: [{ id: 37854 }] };
        return { movie_results: [], tv_results: [] };
      }
    }
    if (urlStr.includes('providers.json')) return {};
    return realFetcher.json(ctx, url, options);
  },
  text: (ctx, url, options) => realFetcher.text(ctx, url, options),
  textPost: (ctx, url, data, options) => realFetcher.textPost(ctx, url, data, options),
  head: (ctx, url, options) => realFetcher.head(ctx, url, options),
  fetch: (ctx, url, options) => realFetcher.fetch(ctx, url, options),
  getFinalRedirectUrl: (ctx, url, options, mc, c) => realFetcher.getFinalRedirectUrl(ctx, url, options, mc, c),
  setCookie: (u, c) => realFetcher.setCookie(u, c),
};

const { createSources } = await import(path.join(PROJECT_ROOT, 'src', 'source', 'index.js'));
const sources = createSources(mockFetcher);

// Parse args — can test specific source or all failing ones
const args = process.argv.slice(2);
const sourceId = args[0];
const tmdbId = parseInt(args[1] || '693134');
const type = args[2] || 'movie';
const season = args[3] ? parseInt(args[3]) : undefined;
const episode = args[4] ? parseInt(args[4]) : undefined;

const source = sources.find(s => s.id === sourceId);
if (!source) { console.error('Source not found: ' + sourceId); process.exit(1); }

const id = { id: tmdbId, ...(season ? { season, episode } : {}) };
const ctx = { hostUrl: 'http://localhost:11470' };

console.log(`\n=== Testing ${sourceId} (tmdb:${tmdbId} ${type}${season ? ' S'+season+'E'+episode : ''}) ===\n`);

try {
  const t0 = Date.now();
  const results = await Promise.race([
    source.handleInternal(ctx, type, id),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT after 60s')), 60000)),
  ]);
  const elapsed = Date.now() - t0;
  console.log(`\n=== RESULT: ${Array.isArray(results) ? results.length : 0} streams in ${elapsed}ms ===`);
  if (Array.isArray(results) && results.length > 0) {
    results.slice(0, 5).forEach((r, i) => {
      const url = r.url?.href || r.url || '';
      console.log(`  ${i+1}. ${url.slice(0, 100)}`);
      if (r.meta?.nuvioReferer) console.log(`     Referer: ${r.meta.nuvoReferer}`);
    });
  }
} catch (e) {
  console.log(`\n=== ERROR: ${e.message} ===`);
}
process.exit(0);
