// Comprehensive audit: test ALL sources with movies + TV + anime
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

  // Test cases: movies, TV, anime
  const tests = [
    { name: 'Inception (movie)', tmdbId: '27205', type: 'movie' },
    { name: 'Oppenheimer (movie)', tmdbId: '872585', type: 'movie' },
    { name: 'Breaking Bad S01E01 (TV)', tmdbId: '1396:1:1', type: 'series' },
    { name: 'JJK S01E01 (anime)', tmdbId: '95479:1:1', type: 'series' },
  ];

  console.log(`Auditing ${sources.length} sources with ${tests.length} test cases\n`);

  const results = [];

  for (const source of sources) {
    const id = source.id;
    const label = source.label;
    const testResults = {};
    let anyWorking = false;

    for (const test of tests) {
      const tmdbId = TmdbId.fromString(test.tmdbId);
      const ctx = {
        type: test.type,
        id: tmdbId,
        hostUrl: new URL('https://example.com/'),
        mediaType: test.type === 'series' ? 'tv' : 'movie',
      };

      let streamCount = 0;
      try {
        const final = await Promise.race([
          streamResolver.resolve(ctx, [source], test.type, tmdbId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 30000)),
        ]);
        streamCount = final.streams ? final.streams.length : 0;
      } catch (e) {
        streamCount = -1; // error
      }

      testResults[test.name] = streamCount;
      if (streamCount > 0) anyWorking = true;
    }

    const status = anyWorking ? 'WORKING' : 'BROKEN';
    results.push({ id, label, status, testResults });

    // Print one line per source
    const parts = [];
    for (const test of tests) {
      const v = testResults[test.name];
      parts.push(v > 0 ? String(v) : (v === 0 ? '0' : 'ERR'));
    }
    console.log(
      id.padEnd(22) +
      label.padEnd(18) +
      parts.join(' / ').padStart(20) +
      '  ' + status
    );
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  const working = results.filter(r => r.status === 'WORKING');
  const broken = results.filter(r => r.status === 'BROKEN');

  console.log(`\nSUMMARY: ${working.length} WORKING, ${broken.length} BROKEN (out of ${results.length})`);

  if (broken.length > 0) {
    console.log('\n=== BROKEN SOURCES ===');
    for (const r of broken) {
      const details = [];
      for (const [test, count] of Object.entries(r.testResults)) {
        details.push(`${test}: ${count > 0 ? count : (count === 0 ? '0' : 'ERR')}`);
      }
      console.log(`  ${r.id} (${r.label}) — ${details.join(', ')}`);
    }
  }

  if (working.length > 0) {
    console.log('\n=== WORKING SOURCES ===');
    for (const r of working) {
      const details = [];
      for (const [test, count] of Object.entries(r.testResults)) {
        if (count > 0) details.push(`${test}: ${count}`);
      }
      console.log(`  ${r.id} (${r.label}) — ${details.join(', ')}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
