// Test Itachi source end-to-end with Naruto (TMDB 31911 - TV) and a movie
// Usage: node scripts/test_itachi.cjs

const path = require('path');
process.env.NODE_PATH = path.resolve(__dirname, '..', 'src');
require('module').Module._initPaths();

(async () => {
  // Import source dynamically (ESM)
  const { Itachi } = await import(path.resolve(__dirname, '..', 'src', 'source', 'Itachi.js'));
  const { Fetcher } = await import(path.resolve(__dirname, '..', 'src', 'utils', 'Fetcher.js'));
  const { TmdbId } = await import(path.resolve(__dirname, '..', 'src', 'utils', 'id.js'));

  const fetcher = new Fetcher();
  const source = new Itachi(fetcher);

  // Helper: run handleInternal with proper ctx and parsed TMDB id
  async function runTest(label, idString, type) {
    console.log(`\n=== ${label} ===`);
    const parsedId = TmdbId.fromString(idString.replace('tmdb:', ''));
    const ctx = { type, id: idString, hostUrl: 'http://localhost:11470' };
    try {
      const t0 = Date.now();
      const results = await source.handleInternal(ctx, type, parsedId);
      const dt = Date.now() - t0;
      console.log(`✓ ${results.length} streams in ${dt}ms`);
      for (const r of results.slice(0, 10)) {
        console.log(`  - ${r.url.href.substring(0, 110)}`);
        console.log(`    meta: serverName="${r.meta.serverName}" audio="${r.meta.audioLabel}" subs=${r.meta.subtitles?.length || 0}`);
      }
      return results;
    } catch (e) {
      console.error('✗ Failed:', e?.stack?.split('\n').slice(0, 4).join('\n') || e?.message || e);
      return [];
    }
  }

  // Test 1: Naruto (TV anime) — TMDB 46260, season 1, episode 1
  await runTest('Test 1: Naruto S01E01 (tmdb:46260:1:1)', 'tmdb:46260:1:1', 'series');

  // Test 2: Your Name (anime movie VidHawk has) — TMDB 372058
  await runTest('Test 2: Your Name (tmdb:372058)', 'tmdb:372058', 'movie');

  // Test 3: Non-anime (Inception tmdb:27205) — should return 0 streams
  await runTest('Test 3: Inception (non-anime, should return 0)', 'tmdb:27205', 'movie');

  // Test 4: Spy x Family (TV anime) — TMDB 120089, season 1, episode 1
  await runTest('Test 4: Spy x Family S01E01 (tmdb:120089:1:1)', 'tmdb:120089:1:1', 'series');

  process.exit(0);
})();

