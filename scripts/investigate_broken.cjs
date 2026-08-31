// Investigate EXTRACTOR_FAIL + NO_STREAMS sources — show their returned URLs
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);
  const { createSources } = await import(pathToFileURL(path.join(projectRoot, 'src', 'source', 'index.js')).href);
  const { TmdbId } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'id.js')).href);
  const sources = createSources(fetcher);

  // Sources to investigate — EXTRACTOR_FAIL + key NO_STREAMS
  const investigateIds = [
    // EXTRACTOR_FAIL
    'vidsrc', 'vidzee', 'movie4kto', 'movieshunt', 'vidsrcto2',
    'einschalten', 'megakino', 'frenchcloud', 'streamduck', 'nowhdtime',
    // NO_STREAMS (non-anime)
    'fmovies', 'moviesdrive', 'fshare', '9anime', 'animeworld',
    'cinefreak', 'anivault', 'hdghartv', 'peckle', 'desiflix',
    'movies4u', 'hdhub4u', 'animesalt', 'animeworldindia',
    'oneembed', 'oneshows', 'onedesiremovies',
  ];

  // Test with movie
  const tmdbId = TmdbId.fromString('27205');
  const ctx = { type: 'movie', id: tmdbId, hostUrl: new URL('https://example.com/'), mediaType: 'movie' };

  for (const id of investigateIds) {
    const source = sources.find(s => s.id === id);
    if (!source) { console.log(`\n[${id}] NOT FOUND`); continue; }

    try {
      const results = await Promise.race([
        source.handle(ctx, 'movie', tmdbId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 15000)),
      ]);

      console.log(`\n[${id}] (${source.label}) — ${results.length} results:`);
      for (const r of results.slice(0, 3)) {
        const url = r.url?.href || r.externalUrl || '';
        const host = (() => { try { return new URL(url).hostname; } catch { return '?'; } })();
        console.log(`  ${host} → ${url.slice(0, 100)}`);
        if (r.meta?.sourceId) console.log(`    sourceId: ${r.meta.sourceId}`);
        if (r.requestHeaders) console.log(`    has requestHeaders`);
      }
    } catch (e) {
      console.log(`\n[${id}] (${source.label}) — ERROR: ${e.message.slice(0, 50)}`);
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
