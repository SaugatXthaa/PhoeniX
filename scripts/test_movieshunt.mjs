// Test the MoviesHunt source end-to-end
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'stub-key-for-test';

import { Fetcher } from '../src/utils/Fetcher.js';
import { MoviesHunt } from '../src/source/MoviesHunt.js';
import { TmdbId } from '../src/utils/id.js';
import bytes from 'bytes';

const TMDB_STUB = {
  'movie/634705': { title: 'Spider-Man: Homecoming', release_date: '2017-07-07' },
};

class StubbedFetcher extends Fetcher {
  async json(ctx, url, options = {}) {
    if (url.href.startsWith('https://api.themoviedb.org/3/')) {
      const path = url.href.replace('https://api.themoviedb.org/3/', '').split('?')[0];
      if (TMDB_STUB[path]) return TMDB_STUB[path];
      throw new Error(`no stub for ${path}`);
    }
    return super.json(ctx, url, options);
  }
}

const logger = { info: () => {}, warn: (...a) => console.warn('[WARN]', ...a), error: (...a) => console.error('[ERR]', ...a) };
const fetcher = new StubbedFetcher(logger);
const source = new MoviesHunt(fetcher);
const ctx = { config: { multi: 'on', en: 'on' }, hostUrl: new URL('http://localhost:7000') };

// Test: Spider-Man Homecoming (movie)
console.log('=== Test: Spider-Man: Homecoming (movie) ===');
const movieId = TmdbId.fromString('634705');
const results = await source.handleInternal(ctx, 'movie', movieId);
console.log(`Got ${results.length} streams`);
for (const r of results.slice(0, 8)) {
  const sizeStr = r.meta?.bytes ? ` | ${bytes.format(r.meta.bytes)}` : '';
  console.log(`  - ${r.meta?.title}${sizeStr} | ${r.meta?.height || '?'}p | ${r.url.href.slice(0, 60)}`);
}
