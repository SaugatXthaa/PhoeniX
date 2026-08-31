// Comprehensive audit: test ALL 78 sources individually.
// For each source:
//   1. Call source.handle() with Inception (TMDB 27205, movie)
//   2. Check if source returned any results
//   3. Run results through extractor pipeline
//   4. Check if final streams are produced
//   5. Report: source name, source results count, final streams count, status
//
// Usage:  node scripts/audit_all_sources.cjs
//
// Output: /home/z/my-project/download/source_audit_report.txt

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
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

  console.log(`Total sources to audit: ${sources.length}\n`);
  console.log('Testing each source with: Inception (TMDB 27205, movie)\n');
  console.log('Source ID'.padEnd(25) + 'Source Label'.padEnd(25) + 'Src Results'.padStart(12) + 'Final Streams'.padStart(14) + '  Status');
  console.log('-'.repeat(80));

  const results = [];
  const tmdbId = TmdbId.fromString('27205');
  const ctx = {
    type: 'movie',
    id: tmdbId,
    hostUrl: new URL('https://example.com/'),
    mediaType: 'movie',
  };

  // Test each source INDIVIDUALLY (not in parallel — to get per-source timing)
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const id = source.id || '';
    const label = source.label || '';
    const t0 = Date.now();

    let sourceResultCount = 0;
    let finalStreamCount = 0;
    let status = '';
    let errorMsg = '';

    try {
      // Step 1: Call source.handle() directly
      const sourceResults = await Promise.race([
        source.handle(ctx, 'movie', tmdbId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('SOURCE_TIMEOUT_30s')), 30000)),
      ]);
      sourceResultCount = Array.isArray(sourceResults) ? sourceResults.length : 0;

      if (sourceResultCount === 0) {
        status = 'NO_STREAMS';
      } else {
        // Step 2: Run through StreamResolver to get final streams
        // We pass ONLY this source so we can isolate its contribution
        const final = await Promise.race([
          streamResolver.resolve(ctx, [source], 'movie', tmdbId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('RESOLVE_TIMEOUT_20s')), 20000)),
        ]);
        finalStreamCount = final.streams ? final.streams.length : 0;

        if (finalStreamCount === 0) {
          status = 'EXTRACTOR_FAIL';
        } else {
          status = 'WORKING';
        }
      }
    } catch (e) {
      status = 'ERROR';
      errorMsg = e.message || String(e);
      // Truncate long error messages
      if (errorMsg.length > 60) errorMsg = errorMsg.slice(0, 57) + '...';
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const srcStr = String(sourceResultCount).padStart(6);
    const finalStr = String(finalStreamCount).padStart(8);
    const statusStr = status.padEnd(15);

    console.log(
      id.padEnd(25) +
      label.padEnd(25) +
      srcStr.padStart(12) +
      finalStr.padStart(14) +
      '  ' + statusStr +
      (errorMsg ? ' ' + errorMsg : '') +
      ` (${dt}s)`
    );

    results.push({
      id,
      label,
      sourceResults: sourceResultCount,
      finalStreams: finalStreamCount,
      status,
      error: errorMsg,
      durationSec: parseFloat(dt),
    });

    // Flush to file after each source so we don't lose progress
    flushReport(results, sources.length);
  }

  // Final summary
  console.log('\n' + '='.repeat(80));
  const working = results.filter(r => r.status === 'WORKING');
  const noStreams = results.filter(r => r.status === 'NO_STREAMS');
  const extractorFail = results.filter(r => r.status === 'EXTRACTOR_FAIL');
  const errors = results.filter(r => r.status === 'ERROR');

  console.log(`\nSUMMARY (${results.length} sources audited):`);
  console.log(`  ✅ WORKING:        ${working.length} sources`);
  console.log(`  ⚠️  NO_STREAMS:     ${noStreams.length} sources (source returned 0 results)`);
  console.log(`  ❌ EXTRACTOR_FAIL: ${extractorFail.length} sources (source returned results but extractor produced 0 final streams)`);
  console.log(`  💥 ERROR:          ${errors.length} sources (timed out or crashed)`);

  if (noStreams.length > 0) {
    console.log('\nNO_STREAMS sources (source returned 0 results):');
    for (const r of noStreams) {
      console.log(`  - ${r.id} (${r.label})`);
    }
  }

  if (extractorFail.length > 0) {
    console.log('\nEXTRACTOR_FAIL sources (extractor dropped all streams):');
    for (const r of extractorFail) {
      console.log(`  - ${r.id} (${r.label}) — had ${r.sourceResults} source results but 0 final streams`);
    }
  }

  if (errors.length > 0) {
    console.log('\nERROR sources (timed out or crashed):');
    for (const r of errors) {
      console.log(`  - ${r.id} (${r.label}) — ${r.error}`);
    }
  }

  if (working.length > 0) {
    console.log('\nWORKING sources:');
    for (const r of working) {
      console.log(`  - ${r.id} (${r.label}) — ${r.finalStreams} streams in ${r.durationSec}s`);
    }
  }

  flushReport(results, sources.length, true);
  console.log('\nReport saved to: /home/z/my-project/download/source_audit_report.txt');
}

function flushReport(results, totalSources, isFinal = false) {
  const reportPath = '/home/z/my-project/download/source_audit_report.txt';
  const lines = [];
  lines.push(`PhoeniX Source Audit Report — ${new Date().toISOString()}`);
  lines.push(`Test: Inception (TMDB 27205, movie)`);
  lines.push(`Total sources: ${totalSources}`);
  lines.push(`Audited so far: ${results.length}`);
  lines.push('');
  lines.push('Source ID'.padEnd(25) + 'Label'.padEnd(25) + 'SrcRes'.padStart(8) + 'Final'.padStart(8) + '  Status'.padEnd(18) + 'Duration');
  lines.push('-'.repeat(90));

  for (const r of results) {
    lines.push(
      r.id.padEnd(25) +
      r.label.padEnd(25) +
      String(r.sourceResults).padStart(8) +
      String(r.finalStreams).padStart(8) +
      '  ' + r.status.padEnd(15) +
      (r.error ? r.error.slice(0, 40) : '') +
      '  ' + r.durationSec + 's'
    );
  }

  if (isFinal) {
    const working = results.filter(r => r.status === 'WORKING');
    const noStreams = results.filter(r => r.status === 'NO_STREAMS');
    const extractorFail = results.filter(r => r.status === 'EXTRACTOR_FAIL');
    const errors = results.filter(r => r.status === 'ERROR');

    lines.push('');
    lines.push('='.repeat(90));
    lines.push(`SUMMARY:`);
    lines.push(`  WORKING:        ${working.length} sources`);
    lines.push(`  NO_STREAMS:     ${noStreams.length} sources`);
    lines.push(`  EXTRACTOR_FAIL: ${extractorFail.length} sources`);
    lines.push(`  ERROR:          ${errors.length} sources`);
  }

  // Ensure download directory exists
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'));
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
