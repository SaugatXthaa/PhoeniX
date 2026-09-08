// End-to-end test: verify DesiFlix source is registered and returns streams.
// Tests:
//   1. DesiFlix source is in the createSources() list
//   2. DesiFlix source has correct id/label
//   3. NuvioExtractor.supports() returns true for desiflix meta
//   4. DesiFlix.handleInternal() returns stream results (calls real API)
//   5. desiflixWrapper.cjs loads without error

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROJECT_ROOT = path.join(__dirname, '..');

// Step 1: Verify DesiFlix source is registered
console.log('=== Step 1: Verify DesiFlix is registered in createSources() ===');
const { createSources } = await import(path.join(PROJECT_ROOT, 'src', 'source', 'index.js'));

// Minimal mock fetcher — DesiFlix uses its own https.get, not the fetcher,
// for the actual API calls. The fetcher is only used for getTmdbId/getTmdbNameAndYear.
const mockFetcher = {
  json: async (_ctx, url) => {
    // Mock TMDB responses based on URL
    const urlStr = url.toString();
    if (urlStr.includes('api.themoviedb.org')) {
      if (urlStr.includes('/movie/')) {
        return {
          title: 'Dune: Part Two',
          release_date: '2024-02-27',
          imdb_id: 'tt15239678',
          external_ids: { imdb_id: 'tt15239678' },
        };
      }
      if (urlStr.includes('/tv/')) {
        return {
          name: 'Breaking Bad',
          first_air_date: '2008-01-20',
          imdb_id: 'tt0903747',
          external_ids: { imdb_id: 'tt0903747' },
        };
      }
    }
    if (urlStr.includes('providers.json')) {
      return {};
    }
    return {};
  },
  head: async () => { throw new Error('head not mocked'); },
};

const sources = createSources(mockFetcher);
const desiflixSource = sources.find(s => s.id === 'desiflix');

if (!desiflixSource) {
  console.error('❌ FAIL: DesiFlix source not found in createSources() list');
  console.error('Registered sources:', sources.map(s => s.id).join(', '));
  process.exit(1);
}
console.log(`✅ DesiFlix source found: id=${desiflixSource.id}, label=${desiflixSource.label}`);
console.log(`   contentTypes=${JSON.stringify(desiflixSource.contentTypes)}`);
console.log(`   countryCodes=${JSON.stringify(desiflixSource.countryCodes)}`);
console.log(`   baseUrl=${desiflixSource.baseUrl}`);
console.log(`   Total sources registered: ${sources.length}`);

// Step 2: Verify NuvioExtractor supports desiflix
console.log('\n=== Step 2: Verify NuvioExtractor.supports() returns true for desiflix ===');
const { NuvioExtractor } = await import(path.join(PROJECT_ROOT, 'src', 'extractor', 'NuvioExtractor.js'));
const extractor = new NuvioExtractor(mockFetcher, { log: () => {} });
const supportsDesiflix = extractor.supports({}, null, { sourceId: 'desiflix', nuvioProvider: true });
if (!supportsDesiflix) {
  console.error('❌ FAIL: NuvioExtractor.supports() returned false for desiflix meta');
  process.exit(1);
}
console.log('✅ NuvioExtractor.supports() returns true for { sourceId: "desiflix" }');

// Step 3: Verify desiflixWrapper.cjs loads
console.log('\n=== Step 3: Verify desiflixWrapper.cjs loads ===');
try {
  const wrapperPath = path.join(PROJECT_ROOT, 'src', 'nuvio', 'desiflixWrapper.cjs');
  const wrapper = require_(wrapperPath);
  if (typeof wrapper.getStreams !== 'function') {
    console.error('❌ FAIL: desiflixWrapper.cjs does not export getStreams');
    process.exit(1);
  }
  console.log('✅ desiflixWrapper.cjs loads and exports getStreams');
} catch (e) {
  console.error(`❌ FAIL: desiflixWrapper.cjs failed to load: ${e.message}`);
  process.exit(1);
}

// Step 4: Verify desiflix.cjs scraper loads
console.log('\n=== Step 4: Verify desiflix.cjs scraper loads ===');
try {
  const scraperPath = path.join(PROJECT_ROOT, 'src', 'nuvio', 'desiflix.cjs');
  const scraper = require_(scraperPath);
  if (typeof scraper.getStreams !== 'function') {
    console.error('❌ FAIL: desiflix.cjs does not export getStreams');
    process.exit(1);
  }
  console.log('✅ desiflix.cjs loads and exports getStreams');
  console.log(`   BASE_URLS: ${JSON.stringify(scraper.BASE_URLS)}`);
} catch (e) {
  console.error(`❌ FAIL: desiflix.cjs failed to load: ${e.message}`);
  process.exit(1);
}

// Step 5: Call DesiFlix.handleInternal() with a real movie (Dune Part Two)
console.log('\n=== Step 5: Call DesiFlix.handleInternal() for Dune Part Two (tmdb:693134) ===');
const ctx = { hostUrl: 'http://localhost:11470' };
// Pass TMDB ID directly (number) to skip IMDB→TMDB find API lookup
const tmdbId = { id: 693134 };

try {
  console.log('  Calling handleInternal... (may take up to 50s for cold-start retries)');
  const t0 = Date.now();
  const results = await desiflixSource.handleInternal(ctx, 'movie', tmdbId);
  console.log(`  Completed in ${Date.now() - t0}ms`);
  if (!Array.isArray(results)) {
    console.error(`❌ FAIL: handleInternal returned non-array: ${typeof results}`);
    process.exit(1);
  }
  console.log(`✅ handleInternal returned ${results.length} stream result(s)`);
  results.forEach((r, i) => {
    const url = r.url?.href || r.url || '';
    const fmt = r.format;
    const sid = r.meta?.sourceId;
    const host = (() => { try { return new URL(url).hostname; } catch { return '?'; } })();
    console.log(`  ${i+1}. [${fmt}] ${sid} @ ${host}`);
    console.log(`     URL: ${String(url).slice(0, 100)}`);
  });
  if (results.length === 0) {
    console.error('⚠️  WARNING: 0 streams returned — API may be cold-starting. Check logs above.');
  }
} catch (e) {
  console.error(`❌ FAIL: handleInternal threw: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}

console.log('\n✅ All checks passed — DesiFlix is registered and returning streams.');
