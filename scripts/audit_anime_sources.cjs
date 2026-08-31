// Test the 38 NO_STREAMS sources with JJK anime (TMDB 95479 S01E01)
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

  // The 38 sources that returned 0 for Inception (movie)
  const noStreamIds = [
    'moviebox', 'fmovies', 'moviesdrive', 'zinkmovies', 'netlio', 'fshare',
    '9anime', 'animeworld', 'animeflix', 'anidb', 'anineko', 'anikoto',
    'anikage', 'anibd', '2dhive', 'anidoor', 'cinefreak', 'anivault',
    'anipriv8', 'hdghartv', 'animegg', 'peckle', 'hianime', 'animekai',
    'desiflix', 'movies4u', 'animezey', 'hdhub4u', 'anikototv', 'animesalt',
    'animeworldindia', 'animesdigital', 'anichan', 'animesuge',
    'oneembed', 'oneshows', 'onedesiremovies', 'nikastream'
  ];

  const tmdbId = TmdbId.fromString('95479:1:1');
  const ctx = { type: 'series', id: tmdbId, hostUrl: new URL('https://example.com/'), mediaType: 'tv' };

  console.log(`Testing ${noStreamIds.length} sources with JJK S01E01 (anime)\n`);
  console.log('Source ID'.padEnd(25) + 'Label'.padEnd(25) + 'SrcRes'.padStart(8) + 'Final'.padStart(8) + '  Status');
  console.log('-'.repeat(80));

  const working = [];
  const stillBroken = [];

  for (const id of noStreamIds) {
    const source = sources.find(s => s.id === id);
    if (!source) {
      console.log(id.padEnd(25) + 'NOT FOUND');
      stillBroken.push({ id, reason: 'NOT_FOUND' });
      continue;
    }

    const t0 = Date.now();
    let sourceResults = 0;
    let finalStreams = 0;
    let status = '';
    let err = '';

    try {
      const sr = await Promise.race([
        source.handle(ctx, 'series', tmdbId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_25s')), 25000)),
      ]);
      sourceResults = Array.isArray(sr) ? sr.length : 0;

      if (sourceResults > 0) {
        const final = await Promise.race([
          streamResolver.resolve(ctx, [source], 'series', tmdbId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('RESOLVE_TIMEOUT_15s')), 15000)),
        ]);
        finalStreams = final.streams ? final.streams.length : 0;
        status = finalStreams > 0 ? 'WORKING' : 'EXTRACTOR_FAIL';
      } else {
        status = 'NO_STREAMS';
      }
    } catch (e) {
      status = 'ERROR';
      err = e.message.slice(0, 50);
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      id.padEnd(25) +
      (source.label || '').padEnd(25) +
      String(sourceResults).padStart(8) +
      String(finalStreams).padStart(8) +
      '  ' + status.padEnd(15) +
      (err ? ' ' + err : '') +
      ` (${dt}s)`
    );

    if (status === 'WORKING') {
      working.push({ id, label: source.label, sourceResults, finalStreams });
    } else {
      stillBroken.push({ id, label: source.label, status, sourceResults, finalStreams, err });
    }
  }

  console.log('\n=== ANIME TEST SUMMARY ===');
  console.log(`WORKING for anime: ${working.length}`);
  console.log(`Still broken: ${stillBroken.length}`);

  if (working.length > 0) {
    console.log('\n✅ Sources that work for anime:');
    for (const w of working) {
      console.log(`  - ${w.id} (${w.label}) — ${w.finalStreams} streams`);
    }
  }

  if (stillBroken.length > 0) {
    console.log('\n❌ Still broken (even for anime):');
    for (const s of stillBroken) {
      console.log(`  - ${s.id} (${s.label || '?'}) — ${s.status}${s.err ? ' ' + s.err : ''}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
