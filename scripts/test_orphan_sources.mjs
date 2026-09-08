// Quick test of orphan source files to verify they work before registering.
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
        if (urlStr.includes('/693134')) return { title: 'Dune: Part Two', release_date: '2024-02-27', imdb_id: 'tt15239678', external_ids: { imdb_id: 'tt15239678' }, genres: [{ id: 878 }], original_language: 'en' };
        if (urlStr.includes('/27205')) return { title: 'Inception', release_date: '2010-07-15', imdb_id: 'tt1375666', external_ids: { imdb_id: 'tt1375666' }, genres: [{ id: 878 }], original_language: 'en' };
        return { title: 'Test', release_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/tv/')) {
        if (urlStr.includes('/1396')) return { name: 'Breaking Bad', first_air_date: '2008-01-20', imdb_id: 'tt0903747', external_ids: { imdb_id: 'tt0903747' }, genres: [{ id: 18 }], original_language: 'en' };
        if (urlStr.includes('/31910')) return { name: 'Naruto', first_air_date: '2002-10-03', imdb_id: 'tt0988824', external_ids: { imdb_id: 'tt0988824' }, genres: [{ id: 16 }], original_language: 'ja' };
        return { name: 'Test', first_air_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/find/')) {
        if (urlStr.includes('tt15239678')) return { movie_results: [{ id: 693134 }] };
        if (urlStr.includes('tt1375666')) return { movie_results: [{ id: 27205 }] };
        if (urlStr.includes('tt0903747')) return { tv_results: [{ id: 1396 }] };
        if (urlStr.includes('tt0988824')) return { tv_results: [{ id: 31910 }] };
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
  getFinalRedirectUrl: (ctx, url, options, maxCount, count) => realFetcher.getFinalRedirectUrl(ctx, url, options, maxCount, count),
  setCookie: (url, cookieString) => realFetcher.setCookie(url, cookieString),
};

// Dynamically import each orphan source and test it
const orphans = [
  { file: 'Antova', tc: { tmdbId: 31910, type: 'tv', season: 1, episode: 1, name: 'Naruto' } },
  { file: 'CineHDPlus', tc: { tmdbId: 1396, type: 'tv', season: 1, episode: 1, name: 'Breaking Bad' } },
  { file: 'CineSu', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'Cuevana', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'DahmerMovies', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'DahmerMovies4k', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'FilmeOnlineHD', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'FilmpalastTO', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'Frembed', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'HomeCine', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'KMMovies', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'KinoGer', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'Kokoshka', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'Movy', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'Pahe', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'VegaCatering', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'VidLove', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'VidSpark', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'Vidzee', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'VixSrc', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
  { file: 'AllWish', tc: { tmdbId: 31910, type: 'tv', season: 1, episode: 1, name: 'Naruto' } },
  { file: 'HDHub4uNew', tc: { tmdbId: 693134, type: 'movie', name: 'Dune' } },
];

const ctx = { hostUrl: 'http://localhost:11470' };
let pass = 0, fail = 0;

for (const { file, tc } of orphans) {
  process.stdout.write(`${file.padEnd(18)} `);
  try {
    const mod = await import(path.join(PROJECT_ROOT, 'src', 'source', file + '.js'));
    const ClassName = Object.keys(mod)[0];
    const source = new mod[ClassName](mockFetcher);
    const id = { id: tc.tmdbId, ...(tc.season ? { season: tc.season, episode: tc.episode } : {}) };
    const t0 = Date.now();
    const results = await Promise.race([
      source.handleInternal(ctx, tc.type, id),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 30000)),
    ]);
    const elapsed = Date.now() - t0;
    const count = Array.isArray(results) ? results.length : 0;
    if (count > 0) {
      pass++;
      const sample = results[0]?.url?.href || results[0]?.url || '';
      console.log(`✅ ${count} streams (${elapsed}ms) ${String(sample).slice(0, 60)}`);
    } else {
      fail++;
      console.log(`⚠️  0 streams (${elapsed}ms)`);
    }
  } catch (e) {
    fail++;
    console.log(`❌ ${e.message.slice(0, 60)}`);
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`RESULT: ${pass} PASS, ${fail} FAIL out of ${orphans.length}`);
console.log(`${'═'.repeat(60)}`);
process.exit(0);
