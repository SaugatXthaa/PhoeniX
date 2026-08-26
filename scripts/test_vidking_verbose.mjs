// Single isolated test with verbose logging
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'stub-key-for-test';

import { Fetcher } from '../src/utils/Fetcher.js';
import { VidKing } from '../src/extractor/VidKing.js';
import { fetchProvider, fetchSeed, invalidateSeed, PROVIDERS } from '../src/utils/speedracelight.js';

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR]', ...a),
};
const fetcher = new Fetcher(logger);
const ctx = { config: {}, hostUrl: new URL('http://localhost:7000') };

const meta = { title: 'The Dark Knight', year: 2008, imdbId: 'tt0468569' };

console.log('=== Step 1: fetch seed ===');
const seed = await fetchSeed(fetcher, ctx, 155);
console.log('seed:', seed.slice(0, 30) + '...');

console.log('\n=== Step 2: hit each provider sequentially with 2s gap ===');
for (const provider of PROVIDERS) {
  try {
    const json = await fetchProvider(fetcher, ctx, {
      provider, meta, type: 'movie', tmdbId: 155, seasonId: null, episodeId: null,
    });
    if (json) {
      console.log(`✅ ${provider.name}: ${json.sources.length} sources`);
      for (const s of json.sources.slice(0, 3)) {
        console.log(`   - ${s.quality}  ${s.url.slice(0, 90)}`);
      }
    } else {
      console.log(`⚠️  ${provider.name}: null (no sources or non-401 error)`);
    }
  } catch (e) {
    console.log(`❌ ${provider.name}: threw — ${e.constructor.name}: ${e.message}  status=${e.status}`);
    // If 401, retry
    if (e.status === 401) {
      invalidateSeed(155);
      console.log(`   retrying with fresh seed...`);
      try {
        const json = await fetchProvider(fetcher, ctx, {
          provider, meta, type: 'movie', tmdbId: 155, seasonId: null, episodeId: null,
        });
        if (json) {
          console.log(`   ✅ retry success: ${json.sources.length} sources`);
        } else {
          console.log(`   ⚠️  retry null`);
        }
      } catch (e2) {
        console.log(`   ❌ retry threw: ${e2.message}`);
      }
    }
  }
  await new Promise(r => setTimeout(r, 2000));
}
