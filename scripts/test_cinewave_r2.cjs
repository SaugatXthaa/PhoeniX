// Test CineWave source with R2 expiry filtering
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

  const cwave = sources.find(s => s.id === 'cinewave');
  console.log('CineWave found:', !!cwave);

  // Test: Eye for an Eye 2 (TMDB 1235623) — the movie from the screenshot
  const tmdbId = TmdbId.fromString('1235623');
  const ctx = {
    type: 'movie', id: tmdbId,
    hostUrl: new URL('https://example.com/'),
    mediaType: 'movie',
  };

  console.log('\n=== Eye for an Eye 2 (TMDB 1235623) ===');
  const t0 = Date.now();
  const final = await streamResolver.resolve(ctx, [cwave], 'movie', tmdbId);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`OK [${dt}s] — ${final.streams.length} streams`);

  let r2Count = 0;
  let otherCount = 0;
  for (const s of final.streams) {
    const url = s.url || s.externalUrl || '';
    const isR2 = url.includes('r2.cloudflarestorage') || url.includes('.r2.dev');
    if (isR2) r2Count++;
    else otherCount++;

    // Only show first 15 streams
    if (final.streams.indexOf(s) < 15) {
      const shortUrl = url.slice(0, 80);
      console.log(`  ${isR2 ? 'R2' : 'CDN'} | ${s.name} | ${shortUrl}`);
    }
  }
  console.log(`\nSummary: ${r2Count} R2 streams, ${otherCount} other CDN streams`);
  console.log('(R2 streams should be 0 — expired ones filtered out)');

  // Also verify a working movie still has streams
  console.log('\n=== Inception (TMDB 27205) ===');
  const tmdbId2 = TmdbId.fromString('27205');
  const ctx2 = { type: 'movie', id: tmdbId2, hostUrl: new URL('https://example.com/'), mediaType: 'movie' };
  const final2 = await streamResolver.resolve(ctx2, [cwave], 'movie', tmdbId2);
  console.log(`OK — ${final2.streams.length} streams`);
  let r2_2 = 0;
  for (const s of final2.streams) {
    const url = s.url || s.externalUrl || '';
    if (url.includes('r2.cloudflarestorage') || url.includes('.r2.dev')) r2_2++;
  }
  console.log(`R2 streams: ${r2_2} (should be 0 if all expired)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
