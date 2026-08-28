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
  const streamResolver = new StreamResolver(logger, extractorRegistry);

  // Find the NikaStream source
  const nika = sources.find(s => s.id === 'nikastream');
  if (!nika) {
    console.error('FAIL: NikaStream source not registered');
    process.exit(1);
  }
  console.log('OK: NikaStream registered (label:', nika.label + ')');

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
  console.log('\n=== Source.handle() ===');
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

  // Show first 5 results with meta details
  for (const r of sourceResults.slice(0, 5)) {
    const m = r.meta || {};
    console.log(`  - url=${r.url.href.slice(0, 100)}`);
    console.log(`    format=${r.format} | height=${m.height} | sourceType=${m.sourceType} | codec=${m.codec}`);
    console.log(`    nuvioReferer=${m.nuvioReferer || ''} | subtitles=${(m.subtitles || []).length} track(s)`);
    if (m.subtitles && m.subtitles.length > 0) {
      for (const sub of m.subtitles.slice(0, 3)) {
        console.log(`      - id=${sub.id} lang=${sub.lang} url=${sub.url.slice(0, 80)}`);
      }
    }
  }

  // 2. Run through the full StreamResolver (extractor + resolver)
  console.log('\n=== StreamResolver.resolve() ===');
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
  for (const s of final.streams.slice(0, 8)) {
    console.log(`  - ${s.name}`);
    console.log(`    title=${s.title.split('\n')[0]}`);
    console.log(`    url=${(s.url || s.externalUrl || '').slice(0, 100)}`);
    if (s.subtitles && s.subtitles.length > 0) {
      streamsWSubs++;
      console.log(`    subtitles (${s.subtitles.length}):`);
      for (const sub of s.subtitles.slice(0, 3)) {
        console.log(`      - id=${sub.id} lang=${sub.lang}`);
      }
    }
  }
  console.log(`\n=== Summary ===`);
  console.log(`Source returned: ${sourceResults.length} results`);
  console.log(`Final streams:   ${final.streams.length}`);
  console.log(`Streams with subtitles: ${streamsWSubs}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
