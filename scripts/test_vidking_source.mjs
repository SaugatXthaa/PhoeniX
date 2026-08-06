// End-to-end source→extractor test: simulate Stremio's stream resolution
// for VidKing only (skip the other 26 sources).
// Usage: TMDB_API_KEY=stub-key-for-test node scripts/test_vidking_source.mjs

import { Fetcher } from '../src/utils/Fetcher.js';
import { VidKing as VidKingSource } from '../src/source/VidKing.js';
import { VidKing as VidKingExtractor } from '../src/extractor/VidKing.js';
import { TmdbId } from '../src/utils/id.js';

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR]', ...a),
};

const TMDB_STUB = {
  'movie/155': { title: 'The Dark Knight', release_date: '2008-07-16' },
  'movie/155/external_ids': { imdb_id: 'tt0468569' },
};

class StubbedFetcher extends Fetcher {
  async json(ctx, url, options = {}) {
    const href = url.href;
    if (href.startsWith('https://api.themoviedb.org/3/')) {
      const path = href.replace('https://api.themoviedb.org/3/', '').split('?')[0];
      if (TMDB_STUB[path]) return TMDB_STUB[path];
      const base = path.replace(/\/external_ids$/, '');
      if (TMDB_STUB[base]) return TMDB_STUB[base];
      throw new Error(`no TMDB stub for ${path}`);
    }
    return super.json(ctx, url, options);
  }
}

const fetcher = new StubbedFetcher(logger);
const source = new VidKingSource(fetcher);
const extractor = new VidKingExtractor(fetcher, logger);

const ctx = { config: { multi: 'on', en: 'on' }, hostUrl: new URL('http://localhost:7000') };

console.log('=== Step 1: source.handle(ctx, "movie", TmdbId(155)) ===');
const tmdbId = TmdbId.fromString('155');
const sourceResults = await source.handle(ctx, 'movie', tmdbId);
console.log(`Source returned ${sourceResults.length} result(s):`);
for (const r of sourceResults) {
  console.log(`  url: ${r.url.href}`);
  console.log(`  meta:`, JSON.stringify(r.meta, null, 2));
}

console.log('\n=== Step 2: extractor.extract(ctx, sourceResult.url, sourceResult.meta) ===');
await new Promise(r => setTimeout(r, 3000));
const streams = await extractor.extract(ctx, sourceResults[0].url, {
  sourceLabel: source.label,
  sourceId: source.id,
  ...sourceResults[0].meta,
});
console.log(`Extractor returned ${streams.length} playable stream(s):`);
for (const s of streams) {
  console.log(`  - ${s.label} | fmt=${s.format} | ${s.meta?.height || '?'}p | cc=${s.meta?.countryCodes?.join(',')} | ${s.url.href.slice(0, 90)}`);
}
