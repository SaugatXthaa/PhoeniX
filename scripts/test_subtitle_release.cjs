// Test SubtitleFetcher with release-name matching
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);
  const ctx = { type: 'movie', hostUrl: new URL('https://example.com/') };
  const { SubtitleFetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'SubtitleFetcher.js')).href);

  // Test cases: with and without release name
  const tests = [
    { name: 'Inception (no release name)', tmdbId: 27205, type: 'movie' },
    { name: 'Inception (with release name — bluray)',
      tmdbId: 27205, type: 'movie',
      releaseName: 'Inception.2010.1080p.BluRay.x264-SPARKS' },
    { name: 'Inception (with release name — web-dl)',
      tmdbId: 27205, type: 'movie',
      releaseName: 'Inception.2010.1080p.WEB-DL.DDP5.1.H.264-FLUX' },
    { name: 'Breaking Bad S01E01 (no release name)',
      tmdbId: 1396, type: 'tv', season: 1, episode: 1 },
    { name: 'Breaking Bad S01E01 (with release name)',
      tmdbId: 1396, type: 'tv', season: 1, episode: 1,
      releaseName: 'Breaking.Bad.S01E01.1080p.BluRay.x264-REWARD' },
  ];

  for (const t of tests) {
    console.log(`\n=== ${t.name} ===`);
    SubtitleFetcher.clearCache();
    const t0 = Date.now();
    const subs = await SubtitleFetcher.fetchByTmdbId(
      fetcher, ctx, t.tmdbId, t.type, t.season, t.episode, t.releaseName
    );
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${subs.length} subtitle track(s)`);
    for (const s of subs) {
      console.log(`  - id=${s.id} | lang=${s.lang}`);
      console.log(`    url=${s.url}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
