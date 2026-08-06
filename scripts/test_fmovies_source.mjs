// Test the Fmovies source end-to-end
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'stub-key-for-test';

import { Fetcher } from '../src/utils/Fetcher.js';
import { Fmovies } from '../src/source/Fmovies.js';

const TMDB_STUB = {
  'movie/634705': { title: 'Spider-Man: Homecoming', release_date: '2017-07-07' },
  'tv/1396': { name: 'Breaking Bad', first_air_date: '2008-01-20' },
};

class StubbedFetcher extends Fetcher {
  async json(ctx, url, options = {}) {
    if (url.href.startsWith('https://api.themoviedb.org/3/')) {
      const path = url.href.replace('https://api.themoviedb.org/3/', '').split('?')[0];
      if (TMDB_STUB[path]) return TMDB_STUB[path];
      const base = path.replace(/\/external_ids$/, '');
      if (TMDB_STUB[base]) return TMDB_STUB[base];
      throw new Error(`no TMDB stub for ${path}`);
    }
    return super.json(ctx, url, options);
  }
}

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR]', ...a),
};

const fetcher = new StubbedFetcher(logger);
const source = new Fmovies(fetcher);
const ctx = { config: { multi: 'on', en: 'on' }, hostUrl: new URL('http://localhost:7000') };

// Test 1: Spider-Man Homecoming (movie)
console.log('=== Test 1: Spider-Man: Homecoming (movie) ===');
const { TmdbId } = await import('../src/utils/id.js');
const movieId = TmdbId.fromString('634705');
const movieResults = await source.handleInternal(ctx, 'movie', movieId);
console.log(`Got ${movieResults.length} streams`);
for (const r of movieResults) {
  console.log(`  - ${r.meta?.title} | ${r.format} | ${r.meta?.height || '?'}p | ${r.url.href.slice(0, 80)}`);
}

// Verify the MP4 is actually playable
if (movieResults.length > 0) {
  const https = await import('https');
  const url = movieResults[0].url;
  console.log(`\nVerifying MP4: ${url.href.slice(0, 80)}...`);
  await new Promise((resolve) => {
    const req = https.default.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-1' },
      timeout: 15000, family: 4,
    }, (res) => {
      res.destroy();
      console.log(`  → HTTP ${res.statusCode}  CT=${res.headers['content-type']}  CL=${res.headers['content-length']}  CR=${res.headers['content-range']}`);
      resolve();
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

// Test 2: Breaking Bad S1E1 (TV)
console.log('\n=== Test 2: Breaking Bad S1E1 (TV) ===');
await new Promise(r => setTimeout(r, 3000));
const tvId = TmdbId.fromString('1396:1:1');
const tvResults = await source.handleInternal(ctx, 'series', tvId);
console.log(`Got ${tvResults.length} streams`);
for (const r of tvResults) {
  console.log(`  - ${r.meta?.title} | ${r.format} | ${r.meta?.height || '?'}p | ${r.url.href.slice(0, 80)}`);
}
