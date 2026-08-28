// Smoke-test nikastream scraper with real anime TMDB IDs.
//   - One Piece (TMDB 37854, TV S01E01)
//   - Jujutsu Kaisen (TMDB 95479, TV S01E01)
//   - Naruto (TMDB 246, TV S01E01)
//
// Usage:  node scripts/test_nikastream.cjs

'use strict';

const nika = require('../src/nuvio/nikastream.cjs');

async function test(tmdbId, type, season, episode) {
  const label = `${type} ${tmdbId}${season ? ` S${season}E${episode}` : ''}`;
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  try {
    const streams = await nika.getStreams(String(tmdbId), type, season || null, episode || null);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${streams.length} stream(s)`);
    for (const s of streams.slice(0, 8)) {
      console.log(`  - ${s.name} | q=${s.quality} | type=${s.type}`);
      console.log(`    url=${(s.url || '').slice(0, 110)}`);
      if (s.subtitles && s.subtitles.length) {
        console.log(`    subtitles (${s.subtitles.length}):`);
        for (const sub of s.subtitles.slice(0, 5)) {
          console.log(`      - ${sub.id} | ${sub.lang} | ${sub.url.slice(0, 80)}`);
        }
      }
      if (s.behaviorHints?.proxyHeaders) {
        console.log(`    proxyHeaders: Referer=${s.behaviorHints.proxyHeaders.request.Referer}`);
      }
    }
  } catch (e) {
    console.log(`FAIL — ${e?.message || e}`);
    console.log(e?.stack);
  }
}

(async () => {
  await test(37854, 'tv', 1, 1);   // One Piece
  await test(95479, 'tv', 1, 1);   // Jujutsu Kaisen
  await test(246, 'tv', 1, 1);     // Naruto
})();
