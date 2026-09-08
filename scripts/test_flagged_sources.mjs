// Test each of the 4 flagged Nuvio sources + user-mentioned ones.
// For each source, call handleInternal() with a known TMDB ID and report:
//   - Did the scraper return streams?
//   - What URLs did it return?
//   - What extractor would route them?
//
// Test movies:
//   - Dune: Part Two (tmdb:693134, imdb:tt15239678)
//   - Inception (tmdb:27205, imdb:tt1375666)
// Test anime:
//   - Naruto (tmdb:31910, tv, S1E1)
//   - Your Name (tmdb:372058, movie)

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROJECT_ROOT = path.join(__dirname, '..');

const { createSources } = await import(path.join(PROJECT_ROOT, 'src', 'source', 'index.js'));

// Mock fetcher for TMDB calls — sources that need real TMDB will use this
const mockFetcher = {
  json: async (_ctx, url) => {
    const urlStr = url.toString();
    // TMDB movie details
    if (urlStr.includes('/movie/')) {
      if (urlStr.includes('/693134')) return { title: 'Dune: Part Two', release_date: '2024-02-27', imdb_id: 'tt15239678', external_ids: { imdb_id: 'tt15239678' } };
      if (urlStr.includes('/27205')) return { title: 'Inception', release_date: '2010-07-15', imdb_id: 'tt1375666', external_ids: { imdb_id: 'tt1375666' } };
      if (urlStr.includes('/372058')) return { title: 'Your Name', release_date: '2016-08-26', imdb_id: 'tt5311514', external_ids: { imdb_id: 'tt5311514' } };
      return { title: 'Test Movie', release_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' } };
    }
    if (urlStr.includes('/tv/')) {
      if (urlStr.includes('/31910')) return { name: 'Naruto', first_air_date: '2002-10-03', imdb_id: 'tt0988824', external_ids: { imdb_id: 'tt0988824' } };
      if (urlStr.includes('/1396')) return { name: 'Breaking Bad', first_air_date: '2008-01-20', imdb_id: 'tt0903747', external_ids: { imdb_id: 'tt0903747' } };
      return { name: 'Test Show', first_air_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' } };
    }
    if (urlStr.includes('/find/')) {
      // IMDB → TMDB find
      if (urlStr.includes('tt15239678')) return { movie_results: [{ id: 693134 }] };
      if (urlStr.includes('tt1375666')) return { movie_results: [{ id: 27205 }] };
      if (urlStr.includes('tt5311514')) return { movie_results: [{ id: 372058 }] };
      if (urlStr.includes('tt0988824')) return { tv_results: [{ id: 31910 }] };
      if (urlStr.includes('tt0903747')) return { tv_results: [{ id: 1396 }] };
      return { movie_results: [], tv_results: [] };
    }
    if (urlStr.includes('providers.json')) return {};
    return {};
  },
  head: async () => { throw new Error('head not mocked'); },
};

const sources = createSources(mockFetcher);

// Sources to test (the 4 flagged + user-mentioned)
const testTargets = [
  { id: 'moviesdrivev2', label: 'MoviesDrive V2', tmdb: { id: 693134 }, type: 'movie', name: 'Dune Part Two' },
  { id: 'movieshuntv2', label: 'MoviesHunt V2', tmdb: { id: 693134 }, type: 'movie', name: 'Dune Part Two' },
  { id: 'hdhub4uv2', label: 'HDHub4u V2', tmdb: { id: 693134 }, type: 'movie', name: 'Dune Part Two' },
  { id: 'hindmovie', label: 'HindMovie', tmdb: { id: 693134 }, type: 'movie', name: 'Dune Part Two' },
  { id: 'bollyflix', label: 'BollyFlix', tmdb: { id: 693134 }, type: 'movie', name: 'Dune Part Two' },
  { id: 'stellarrip', label: 'StellarRip', tmdb: { id: 693134 }, type: 'movie', name: 'Dune Part Two' },
  { id: 'rivestream', label: 'RiveStream', tmdb: { id: 693134 }, type: 'movie', name: 'Dune Part Two' },
];

const ctx = { hostUrl: 'http://localhost:11470' };

for (const target of testTargets) {
  const source = sources.find(s => s.id === target.id);
  if (!source) {
    console.log(`\n❌ ${target.label} (${target.id}) — source not found`);
    continue;
  }
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`TEST: ${target.label} (${target.id}) — ${target.name} (${target.type})`);
  console.log(`${'═'.repeat(70)}`);

  const t0 = Date.now();
  try {
    // Use Promise.race with a timeout to avoid hanging
    const results = await Promise.race([
      source.handleInternal(ctx, target.type, target.tmdb),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT after 60s')), 60000)),
    ]);
    const elapsed = Date.now() - t0;

    if (!Array.isArray(results)) {
      console.log(`  ❌ Returned non-array: ${typeof results} (${elapsed}ms)`);
      continue;
    }

    if (results.length === 0) {
      console.log(`  ⚠️  0 streams returned (${elapsed}ms) — scraper may be broken or no results for this title`);
      continue;
    }

    console.log(`  ✅ ${results.length} stream(s) returned (${elapsed}ms):`);
    results.slice(0, 5).forEach((r, i) => {
      const url = r.url?.href || r.url || '';
      const fmt = r.format || '?';
      const host = (() => { try { return new URL(url).hostname; } catch { return '?'; } })();
      const sid = r.meta?.sourceId || '?';
      const nuvio = r.meta?.nuvioProvider ? ' [nuvio]' : '';
      const referer = r.meta?.nuvioReferer || r.requestHeaders?.Referer || '';
      console.log(`    ${i+1}. [${fmt}] ${sid}${nuvio} @ ${host}`);
      console.log(`       URL: ${String(url).slice(0, 100)}`);
      if (referer) console.log(`       Referer: ${referer}`);
    });
    if (results.length > 5) console.log(`    ... and ${results.length - 5} more`);
  } catch (e) {
    const elapsed = Date.now() - t0;
    console.log(`  ❌ ERROR after ${elapsed}ms: ${e.message}`);
    if (e.stack) console.log(`     ${e.stack.split('\n')[1]?.trim() || ''}`);
  }
}
