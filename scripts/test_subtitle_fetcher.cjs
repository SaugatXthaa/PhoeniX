// Test SubtitleFetcher directly (no project pipeline).
//
// Usage:  node scripts/test_subtitle_fetcher.cjs

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  // Build a real Fetcher (we need it for TMDB API)
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);
  const ctx = { type: 'movie', hostUrl: new URL('https://example.com/') };

  const { SubtitleFetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'SubtitleFetcher.js')).href);

  // Test cases — movies + TV
  const tests = [
    { name: 'Inception (movie)',         tmdbId: 27205,    type: 'movie' },
    { name: 'The Dark Knight (movie)',   tmdbId: 155,      type: 'movie' },
    { name: 'Breaking Bad S01E01 (tv)',  tmdbId: 1396,     type: 'tv', season: 1, episode: 1 },
    { name: 'Game of Thrones S01E01',    tmdbId: 1399,     type: 'tv', season: 1, episode: 1 },
  ];

  for (const t of tests) {
    console.log(`\n=== ${t.name} ===`);
    const t0 = Date.now();
    const subs = await SubtitleFetcher.fetchByTmdbId(
      fetcher, ctx, t.tmdbId, t.type, t.season, t.episode
    );
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${subs.length} subtitle track(s)`);
    for (const s of subs.slice(0, 6)) {
      console.log(`  - id=${s.id} | lang=${s.lang}`);
      console.log(`    url=${s.url}`);
    }
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
