// Check actual full proxy URLs being delivered to Stremio.
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

  const cbr = sources.find(s => s.id === 'cinebyrocks');
  const tmdbId = TmdbId.fromString('27205');
  const ctx = {
    type: 'movie', id: tmdbId,
    hostUrl: new URL('https://example.com/'),
    mediaType: 'movie',
  };

  const final = await streamResolver.resolve(ctx, [cbr], 'movie', tmdbId);
  console.log(`Final streams: ${final.streams.length}`);
  for (const s of final.streams) {
    console.log(`\n--- ${s.name} ---`);
    console.log(`title: ${s.title.split('\n')[0]}`);
    console.log(`FULL url: ${s.url || s.externalUrl}`);
    if (s.behaviorHints?.proxyHeaders) {
      console.log(`proxyHeaders: ${JSON.stringify(s.behaviorHints.proxyHeaders.request)}`);
    }
  }
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
