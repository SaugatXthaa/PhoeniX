// Smoke-test the updated cinejoy scraper with a real TMDB id.
//   - Inception (TMDB 27205, movie) — should return multiple HLS streams
//   - The Dark Knight (TMDB 155, movie) — should return Lisbon/Solara/Athens/Castle streams
//   - Breaking Bad (TMDB 1396, TV S01E01) — should return Castle/Athens HLS
//
// Usage:  node scripts/test_cinejoy.js

'use strict';

const path = require('path');
const cinejoy = require('../src/nuvio/cinejoy_all_in_one.cjs');

async function test(tmdbId, type, season, episode) {
  const label = `${type} ${tmdbId}${season ? ` S${season}E${episode}` : ''}`;
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  try {
    const streams = await cinejoy.getStreams(String(tmdbId), type, season || null, episode || null);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${streams.length} stream(s)`);
    for (const s of streams.slice(0, 12)) {
      console.log(`  - ${s.name} | q=${s.quality} | type=${s.type}`);
      console.log(`    url=${(s.url || '').slice(0, 110)}`);
      if (s.headers) console.log(`    headers=${JSON.stringify(s.headers)}`);
      if (s.behaviorHints?.proxyHeaders) {
        console.log(`    proxyHeaders=${JSON.stringify(s.behaviorHints.proxyHeaders)}`);
      }
    }
  } catch (e) {
    console.log(`FAIL — ${e?.message || e}`);
    console.log(e?.stack);
  }
}

(async () => {
  await test(27205, 'movie');           // Inception
  await test(155, 'movie');             // The Dark Knight
  await test(1396, 'tv', 1, 1);         // Breaking Bad S01E01
})();
