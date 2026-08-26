// Test: verify the VidKing fallback for non-vidking embed URLs
// Simulates what happens when CineWave/PrimeShows/etc. produce embed URLs
// that no extractor matches — the VidKing extractor should kick in via meta.vidking.
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'stub-key-for-test';

import { Fetcher } from '../src/utils/Fetcher.js';
import { VidKing } from '../src/extractor/VidKing.js';

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR]', ...a),
};

// Stub TMDB responses
const TMDB_STUB = {
  'movie/155': { title: 'The Dark Knight', release_date: '2008-07-16' },
  'movie/155/external_ids': { imdb_id: 'tt0468569' },
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

const fetcher = new StubbedFetcher(logger);
const extractor = new VidKing(fetcher, logger);
const ctx = { config: {}, hostUrl: new URL('http://localhost:7000') };

// Simulate what happens when CineWave produces a 2embed.cc URL
// (no dedicated extractor matches it, but meta.vidking is present)
const testCases = [
  {
    label: '2embed.cc (CineWave embed source, no extractor)',
    url: 'https://2embed.cc/embed/movie/155',
    meta: {
      sourceLabel: 'CineWave',
      sourceId: 'cinewave',
      countryCodes: ['multi'],
      title: 'The Dark Knight (2008) (2Embed)',
      vidking: { name: 'The Dark Knight', year: 2008, imdbId: 'tt0468569', tmdbId: 155 },
    },
  },
  {
    label: 'vidfast.pro (CineWave/PrimeShows, no extractor)',
    url: 'https://vidfast.pro/movie/155',
    meta: {
      sourceLabel: 'CineWave',
      sourceId: 'cinewave',
      countryCodes: ['multi'],
      title: 'The Dark Knight (2008) (VidFast)',
      vidking: { name: 'The Dark Knight', year: 2008, imdbId: 'tt0468569', tmdbId: 155 },
    },
  },
  {
    label: 'peachify.top (CineWave, no extractor)',
    url: 'https://peachify.top/embed/movie/155',
    meta: {
      sourceLabel: 'CineWave',
      sourceId: 'cinewave',
      countryCodes: ['multi'],
      title: 'The Dark Knight (2008) (Peachify)',
      vidking: { name: 'The Dark Knight', year: 2008, imdbId: 'tt0468569', tmdbId: 155 },
    },
  },
];

for (const tc of testCases) {
  console.log('\n========================================');
  console.log('TEST:', tc.label);
  console.log('URL:', tc.url);
  console.log('========================================');

  try {
    const url = new URL(tc.url);
    // The VidKing extractor's supports() returns false for non-vidking URLs,
    // but the ExtractorRegistry routes here via the meta.vidking fallback.
    const results = await extractor.extract(ctx, url, tc.meta);
    console.log(`Got ${results.length} streams`);
    for (const r of results.slice(0, 5)) {
      console.log(`  - ${r.label} | fmt=${r.format} | ${r.meta?.height || '?'}p | cc=${r.meta?.countryCodes?.join(',')} | ${r.url.href.slice(0, 90)}`);
    }
    if (results.length > 5) console.log(`  ... and ${results.length - 5} more`);
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  // Wait between tests to avoid 429
  await new Promise(r => setTimeout(r, 8000));
}
