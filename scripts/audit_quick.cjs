// Quick audit: test each source individually with 1 movie + 1 anime
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

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

  // Test: Inception (movie) + JJK S01E01 (anime)
  const movieTmdb = TmdbId.fromString('27205');
  const movieCtx = { type: 'movie', id: movieTmdb, hostUrl: new URL('https://example.com/'), mediaType: 'movie' };
  const animeTmdb = TmdbId.fromString('95479:1:1');
  const animeCtx = { type: 'series', id: animeTmdb, hostUrl: new URL('https://example.com/'), mediaType: 'tv' };

  const lines = [];
  lines.push('PhoeniX Source Audit — ' + new Date().toISOString());
  lines.push('Tests: Inception (movie) + JJK S01E01 (anime)');
  lines.push('');
  lines.push('Source ID'.padEnd(22) + 'Label'.padEnd(18) + 'Movie'.padStart(8) + 'Anime'.padStart(8) + '  Status');
  lines.push('-'.repeat(70));

  const working = [];
  const broken = [];

  for (const source of sources) {
    let movieCount = 0, animeCount = 0;
    
    // Test movie
    try {
      const final = await Promise.race([
        streamResolver.resolve(movieCtx, [source], 'movie', movieTmdb),
        new Promise((_, rej) => setTimeout(() => rej(new Error('T')), 20000)),
      ]);
      movieCount = final.streams?.length || 0;
    } catch (e) { movieCount = -1; }

    // Test anime
    try {
      const final = await Promise.race([
        streamResolver.resolve(animeCtx, [source], 'series', animeTmdb),
        new Promise((_, rej) => setTimeout(() => rej(new Error('T')), 20000)),
      ]);
      animeCount = final.streams?.length || 0;
    } catch (e) { animeCount = -1; }

    const isWorking = movieCount > 0 || animeCount > 0;
    const status = isWorking ? 'WORKING' : 'BROKEN';
    const mc = movieCount > 0 ? String(movieCount) : (movieCount === 0 ? '0' : 'ERR');
    const ac = animeCount > 0 ? String(animeCount) : (animeCount === 0 ? '0' : 'ERR');
    
    const line = source.id.padEnd(22) + (source.label || '').padEnd(18) + mc.padStart(8) + ac.padStart(8) + '  ' + status;
    lines.push(line);
    console.log(line);

    if (isWorking) {
      working.push({ id: source.id, label: source.label, movie: movieCount, anime: animeCount });
    } else {
      broken.push({ id: source.id, label: source.label, movie: movieCount, anime: animeCount });
    }

    // Flush after each source
    fs.writeFileSync('/home/z/my-project/download/audit_report.txt', lines.join('\n') + '\n');
  }

  lines.push('');
  lines.push('='.repeat(70));
  lines.push(`SUMMARY: ${working.length} WORKING, ${broken.length} BROKEN (out of ${sources.length})`);
  
  if (broken.length > 0) {
    lines.push('');
    lines.push('BROKEN SOURCES:');
    for (const b of broken) {
      lines.push(`  ${b.id} (${b.label}) — movie=${b.movie < 0 ? 'ERR' : b.movie}, anime=${b.anime < 0 ? 'ERR' : b.anime}`);
    }
  }
  
  if (working.length > 0) {
    lines.push('');
    lines.push('WORKING SOURCES:');
    for (const w of working) {
      lines.push(`  ${w.id} (${w.label}) — movie=${w.movie}, anime=${w.anime}`);
    }
  }

  fs.writeFileSync('/home/z/my-project/download/audit_report.txt', lines.join('\n') + '\n');
  console.log('\nReport saved to download/audit_report.txt');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
