// Test that the AniDoor fix correctly skips non-anime content for "Supergirl 2026"
'use strict';

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

// Use the real Fetcher (it makes real TMDB API calls)
async function testAniDoorSupergirl() {
  console.log('\n========== ANIDOOR on SUPERGIRL 2026 (should return 0) ==========');
  const AniDoorModule = await import('../src/source/AniDoor.js');
  const AniDoor = AniDoorModule.AniDoor;
  const { Fetcher } = await import('../src/utils/Fetcher.js');

  const fetcher = new Fetcher(console);
  const anidoor = new AniDoor(fetcher);

  // Mock context with TMDB ID for Supergirl 2026 (1081003) — a movie, no season
  const ctx = {
    hostUrl: new URL('https://example.com'),
    id: 'test',
    ip: '127.0.0.1',
    config: { multi: 'on', en: 'on' },
  };

  // Build the ID for "tmdb:1081003" movie (no season)
  const { TmdbId } = await import('../src/utils/id.js');
  const id = TmdbId.fromString('1081003');

  const t0 = Date.now();
  try {
    const results = await anidoor.handleInternal(ctx, 'movie', id);
    const dt = Date.now() - t0;
    console.log(`  AniDoor returned ${results.length} streams in ${dt}ms`);
    if (results.length === 0) {
      console.log('  ✅ PASS: AniDoor correctly returned 0 streams for non-anime movie');
    } else {
      console.log('  ❌ FAIL: AniDoor returned streams for non-anime movie!');
      for (const r of results.slice(0, 3)) {
        console.log(`    -> ${r.meta?.title} ${r.url?.href?.slice(0, 80)}`);
      }
    }
  } catch (e) {
    console.error(`  ERROR:`, e?.message || e);
  }
}

// Test 2: AniDoor SHOULD still work for actual anime (Naruto, One Piece, etc.)
async function testAniDoorAnime() {
  console.log('\n========== ANIDOOR on NARUTO (anime series, should return streams) ==========');
  const AniDoorModule = await import('../src/source/AniDoor.js');
  const AniDoor = AniDoorModule.AniDoor;
  const { Fetcher } = await import('../src/utils/Fetcher.js');

  const fetcher = new Fetcher(console);
  const anidoor = new AniDoor(fetcher);
  const ctx = {
    hostUrl: new URL('https://example.com'),
    id: 'test',
    ip: '127.0.0.1',
    config: { multi: 'on', en: 'on' },
  };

  // Naruto Shippuden TMDB ID is 31911. We're requesting S1E1.
  const { TmdbId } = await import('../src/utils/id.js');
  const id = TmdbId.fromString('31911:1:1');

  const t0 = Date.now();
  try {
    const results = await anidoor.handleInternal(ctx, 'series', id);
    const dt = Date.now() - t0;
    console.log(`  AniDoor returned ${results.length} streams in ${dt}ms`);
    if (results.length > 0) {
      console.log('  ✅ PASS: AniDoor correctly returned streams for real anime');
      for (const r of results.slice(0, 3)) {
        console.log(`    -> ${r.meta?.title}`);
      }
    } else {
      console.log('  ⚠️  AniDoor returned 0 streams for Naruto — investigate');
    }
  } catch (e) {
    console.error(`  ERROR:`, e?.message || e);
  }
}

(async () => {
  await testAniDoorSupergirl().catch(e => console.error('uncaught:', e));
  await testAniDoorAnime().catch(e => console.error('uncaught:', e));
  console.log('\n========== DONE ==========');
  process.exit(0);
})();
