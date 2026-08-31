// Integration test for Stellar source through the full project pipeline.
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);

  const { createSources } = await import(pathToFileURL(path.join(projectRoot, 'src', 'source', 'index.js')).href);
  const { createExtractors, ExtractorRegistry } = await import(pathToFileURL(path.join(projectRoot, 'src', 'extractor', 'index.js')).href);
  const { StreamResolver } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'StreamResolver.js')).href);
  const { TmdbId } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'id.js')).href);

  const sources = createSources(fetcher);
  const extractors = createExtractors(fetcher, logger);
  const extractorRegistry = new ExtractorRegistry(logger, extractors);
  const streamResolver = new StreamResolver(logger, extractorRegistry, fetcher);

  const stellar = sources.find(s => s.id === 'stellar');
  if (!stellar) {
    console.error('FAIL: Stellar source not registered');
    process.exit(1);
  }
  console.log('OK: Stellar registered (label:', stellar.label + ')');
  console.log('Total sources:', sources.length);
  console.log('Goated removed:', !sources.find(s => s.id === 'goated'));

  const tests = [
    { name: 'Inception (movie)', tmdbId: '27205', type: 'movie' },
    { name: 'Oppenheimer (4K movie)', tmdbId: '872585', type: 'movie' },
    { name: 'Breaking Bad S01E01 (TV)', tmdbId: '1396:1:1', type: 'series' },
    { name: 'JJK S01E01 (anime)', tmdbId: '95479:1:1', type: 'series' },
  ];

  for (const t of tests) {
    console.log(`\n=== ${t.name} ===`);
    const tmdbId = TmdbId.fromString(t.tmdbId);
    const ctx = {
      type: t.type, id: tmdbId,
      hostUrl: new URL('https://example.com/'),
      mediaType: t.type === 'series' ? 'tv' : 'movie',
    };

    const t0 = Date.now();
    let final;
    try {
      final = await Promise.race([
        streamResolver.resolve(ctx, [stellar], t.type, tmdbId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 60s')), 60000)),
      ]);
    } catch (e) {
      console.error(`FAIL [${((Date.now() - t0) / 1000).toFixed(1)}s] — ${e.message}`);
      continue;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${final.streams.length} final stream(s)`);
    let withSubs = 0;
    for (const s of final.streams.slice(0, 5)) {
      console.log(`  - ${s.name}`);
      console.log(`    title=${s.title.split('\n')[0]}`);
      console.log(`    url=${(s.url || s.externalUrl || '').slice(0, 100)}`);
      if (s.subtitles?.length) {
        withSubs++;
        console.log(`    subtitles: ${s.subtitles.length} track(s) — first: ${s.subtitles[0].lang}`);
      }
    }
    console.log(`Summary: ${final.streams.length} streams, ${withSubs} with subtitles`);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
