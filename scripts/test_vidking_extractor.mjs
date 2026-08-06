// End-to-end test of the VidKing extractor — Fetcher is intercepted for TMDB calls only
// (TMDB_API_KEY is set via shell — see scripts/run_test_vidking.sh)

import { Fetcher } from '../src/utils/Fetcher.js';
import { VidKing } from '../src/extractor/VidKing.js';

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR]', ...a),
};

const TMDB_STUB = {
  // movie/155 = The Dark Knight
  'movie/155': { title: 'The Dark Knight', year: 2008, imdb_id: 'tt0468569' },
  // tv/1396 = Breaking Bad
  'tv/1396': { name: 'Breaking Bad', first_air_date: '2008-01-20', imdb_id: 'tt0903747' },
  // tv/1396/external_ids
  'tv/1396/external_ids': { imdb_id: 'tt0903747' },
  'movie/155/external_ids': { imdb_id: 'tt0468569' },
};

class StubbedFetcher extends Fetcher {
  async json(ctx, url, options = {}) {
    // Intercept TMDB calls
    const href = url.href;
    if (href.startsWith('https://api.themoviedb.org/3/')) {
      const path = href.replace('https://api.themoviedb.org/3/', '').split('?')[0];
      // For find/{imdbId} we don't stub — we only test TMDB-ID-based embed URLs
      if (path.startsWith('find/')) {
        // Return empty (we're not testing imdb→tmdb conversion)
        return { movie_results: [], tv_results: [] };
      }
      // Look for a stub match — try the path with and without /external_ids
      if (TMDB_STUB[path]) return TMDB_STUB[path];
      // Fallback: try the base path (without /external_ids)
      const base = path.replace(/\/external_ids$/, '');
      if (TMDB_STUB[base]) {
        return TMDB_STUB[base];
      }
      throw new Error(`no TMDB stub for ${path}`);
    }
    return super.json(ctx, url, options);
  }
}

const fetcher = new StubbedFetcher(logger);
const extractor = new VidKing(fetcher, logger);

const ctx = {
  config: {},
  hostUrl: new URL('http://localhost:7000'),
};

console.log('=== Test 1: VidKing.extract() on movie/155 (The Dark Knight) ===');
// Simulate metadata pre-resolved by the VidKing source
const url1 = new URL('https://www.vidking.net/embed/movie/155');
const r1 = await extractor.extract(ctx, url1, {
  sourceLabel: 'VidKing',
  sourceId: 'vidking',
  title: 'The Dark Knight (2008)',
  vidking: { name: 'The Dark Knight', year: 2008, imdbId: 'tt0468569', tmdbId: 155 },
});
console.log(`Got ${r1.length} streams`);
for (const r of r1) {
  console.log(`  - ${r.label} | fmt=${r.format} | ${r.meta?.height || '?'}p | cc=${r.meta?.countryCodes?.join(',')} | ${r.url.href.slice(0, 100)}`);
}

console.log('\n=== Test 2: VidKing.extract() on tv/1396/1/1 (Breaking Bad S1E1) ===');
await new Promise(r => setTimeout(r, 5000));
const url2 = new URL('https://www.vidking.net/embed/tv/1396/1/1');
const r2 = await extractor.extract(ctx, url2, {
  sourceLabel: 'VidKing',
  sourceId: 'vidking',
  title: 'Breaking Bad S01E01',
  vidking: { name: 'Breaking Bad', year: 2008, imdbId: 'tt0903747', tmdbId: 1396, season: 1, episode: 1 },
});
console.log(`Got ${r2.length} streams`);
for (const r of r2) {
  console.log(`  - ${r.label} | fmt=${r.format} | ${r.meta?.height || '?'}p | cc=${r.meta?.countryCodes?.join(',')} | ${r.url.href.slice(0, 100)}`);
}

console.log('\n=== Test 3: Verify a sample stream URL actually plays ===');
const allStreams = [...r1, ...r2];
if (allStreams.length > 0) {
  const sample = allStreams[0].url;
  console.log(`Probing: ${sample.href}`);
  const proto = sample.protocol === 'https:' ? (await import('https')).default : (await import('http')).default;
  await new Promise((resolve) => {
    const req = proto.request({
      hostname: sample.hostname, path: sample.pathname + sample.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-1' },
      timeout: 15000, family: 4,
    }, (res) => {
      res.destroy();
      console.log(`  → HTTP ${res.statusCode}  ct=${res.headers['content-type']}  cl=${res.headers['content-length']}  cr=${res.headers['content-range']}  ranges=${res.headers['accept-ranges']}`);
      resolve();
    });
    req.on('error', (e) => { console.log('  → error:', e.message); resolve(); });
    req.on('timeout', () => { req.destroy(); console.log('  → timeout'); resolve(); });
    req.end();
  });
}
