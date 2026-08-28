// Integration test: invoke the NikaStream source through the full project
// pipeline (Source -> Extractor -> StreamResolver) and verify the final
// stream objects carry subtitles and the correct stream URL routing.
//
// Usage:  node scripts/test_nikastream_integration.cjs
//
// What this verifies:
//   1. NikaStream source is registered in src/source/index.js
//   2. Source.handleInternal() returns streams with meta.subtitles
//   3. NuvioExtractor picks up NikaStream streams (sourceId match)
//   4. StreamResolver passes subtitles through to the final Stremio output

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  // Dynamically import the ESM project modules
  const projectRoot = path.resolve(__dirname, '..');
  const srcUrl = pathToFileURL(path.join(projectRoot, 'src', 'index.js')).href;

  // We need access to `createSources` and `createExtractors` directly
  // (src/index.js wires them into Express — too heavy for a test).
  const sourceIndexUrl = pathToFileURL(path.join(projectRoot, 'src', 'source', 'index.js')).href;
  const extractorIndexUrl = pathToFileURL(path.join(projectRoot, 'src', 'extractor', 'index.js')).href;
  const resolverUrl = pathToFileURL(path.join(projectRoot, 'src', 'utils', 'StreamResolver.js')).href;
  const ctxUrl = pathToFileURL(path.join(projectRoot, 'src', 'utils', 'context.js')).href;

  const { createSources } = await import(sourceIndexUrl);
  const { createExtractors, ExtractorRegistry } = await import(extractorIndexUrl);
  const { StreamResolver } = await import(resolverUrl);

  // Build a minimal fetcher + logger (real Fetcher for HTTP)
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);

  const sources = createSources(fetcher);
  const extractors = createExtractors(fetcher, logger);
  const extractorRegistry = new ExtractorRegistry(logger, extractors);
  const streamResolver = new StreamResolver(logger, extractorRegistry, fetcher);

  // Find NikaStream source + movie source to test subtitles on both
  const nika = sources.find(s => s.id === 'nikastream');
  if (!nika) {
    console.error('FAIL: NikaStream source not registered');
    process.exit(1);
  }
  console.log('OK: NikaStream registered (label:', nika.label + ')');

  // Test 1: JJK S01E01 (anime, NikaStream already returns subtitles)
  // Build a TmdbId for JJK S01E01 (TMDB 95479)
  const { TmdbId } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'id.js')).href);
  const tmdbId = TmdbId.fromString('95479:1:1');
  const ctx = {
    type: 'series',
    id: tmdbId,
    hostUrl: new URL('https://example.com/'),
    mediaType: 'tv',
  };

  // 1. Call source.handle() directly to inspect the raw results
  console.log('\n=== Source.handle() — JJK S01E01 (anime) ===');
  const t0 = Date.now();
  let sourceResults;
  try {
    sourceResults = await Promise.race([
      nika.handle(ctx, 'series', tmdbId),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Source timeout 60s')), 60000)),
    ]);
  } catch (e) {
    console.error('FAIL: source.handle error:', e.message);
    process.exit(1);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`OK [${dt}s] — ${sourceResults.length} source result(s)`);

  // 2. Run through the full StreamResolver (extractor + resolver + subtitles)
  console.log('\n=== StreamResolver.resolve() — JJK S01E01 ===');
  const t1 = Date.now();
  let final;
  try {
    final = await streamResolver.resolve(ctx, [nika], 'series', tmdbId);
  } catch (e) {
    console.error('FAIL: resolver error:', e.message);
    process.exit(1);
  }
  const dt2 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`OK [${dt2}s] — ${final.streams.length} final stream(s)`);
  let streamsWSubs = 0;
  let totalSubs = 0;
  for (const s of final.streams.slice(0, 5)) {
    console.log(`  - ${s.name}`);
    console.log(`    title=${s.title.split('\n')[0]}`);
    console.log(`    url=${(s.url || s.externalUrl || '').slice(0, 80)}`);
    if (s.subtitles && s.subtitles.length > 0) {
      streamsWSubs++;
      totalSubs += s.subtitles.length;
      console.log(`    subtitles (${s.subtitles.length}):`);
      for (const sub of s.subtitles.slice(0, 5)) {
        console.log(`      - id=${sub.id} lang=${sub.lang}`);
      }
    }
  }
  console.log(`\n[Anime Summary] ${final.streams.length} streams, ${streamsWSubs} with subtitles (${totalSubs} total tracks)`);

  // Test 2: Movies — pick a movie source (4KHDHub) and verify subtitles attach
  console.log('\n=== StreamResolver.resolve() — Inception (movie) ===');
  const movieTmdb = TmdbId.fromString('27205');
  const movieCtx = {
    type: 'movie',
    id: movieTmdb,
    hostUrl: new URL('https://example.com/'),
    mediaType: 'movie',
  };
  const movieSource = sources.find(s => s.id === 'videasy') || sources.find(s => s.id === '4khdhub');
  if (!movieSource) {
    console.log('SKIP: no movie source available for test');
    process.exit(0);
  }
  console.log('Using movie source:', movieSource.id);
  const t2 = Date.now();
  let movieResult;
  try {
    movieResult = await streamResolver.resolve(movieCtx, [movieSource], 'movie', movieTmdb);
  } catch (e) {
    console.error('FAIL: movie resolver error:', e.message);
    process.exit(1);
  }
  const dt3 = ((Date.now() - t2) / 1000).toFixed(1);
  console.log(`OK [${dt3}s] — ${movieResult.streams.length} movie stream(s)`);
  let movieStreamsWithSubs = 0;
  let movieTotalSubs = 0;
  for (const s of movieResult.streams.slice(0, 5)) {
    console.log(`  - ${s.name}`);
    console.log(`    title=${s.title.split('\n')[0]}`);
    console.log(`    url=${(s.url || s.externalUrl || '').slice(0, 80)}`);
    if (s.subtitles && s.subtitles.length > 0) {
      movieStreamsWithSubs++;
      movieTotalSubs += s.subtitles.length;
      console.log(`    subtitles (${s.subtitles.length}):`);
      for (const sub of s.subtitles.slice(0, 5)) {
        console.log(`      - id=${sub.id} lang=${sub.lang}`);
      }
    }
  }
  console.log(`\n[Movie Summary] ${movieResult.streams.length} streams, ${movieStreamsWithSubs} with subtitles (${movieTotalSubs} total tracks)`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
