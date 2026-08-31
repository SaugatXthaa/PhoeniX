// Test Stellar scraper with movies + TV + anime
'use strict';
const path = require('path');
const stellar = require(path.resolve(__dirname, '..', 'src', 'nuvio', 'stellar.cjs'));

async function test(tmdbId, type, season, episode) {
  const label = `${type} ${tmdbId}${season ? ` S${season}E${episode}` : ''}`;
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  try {
    const streams = await Promise.race([
      stellar.getStreams(String(tmdbId), type, season || null, episode || null),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 45s')), 45000)),
    ]);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${(streams || []).length} stream(s)`);
    for (const s of (streams || []).slice(0, 6)) {
      console.log(`  - ${s.name} | q=${s.quality} | type=${s.type}`);
      console.log(`    url=${(s.url || '').slice(0, 110)}`);
      if (s.subtitles?.length) console.log(`    subtitles: ${s.subtitles.length}`);
    }
    return streams || [];
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`FAIL [${dt}s] — ${e?.message || e}`);
    return [];
  }
}

(async () => {
  // Movies
  await test(27205, 'movie');          // Inception
  await test(872585, 'movie');         // Oppenheimer (4K!)

  // TV
  await test(1396, 'tv', 1, 1);        // Breaking Bad S01E01

  // Anime (TV)
  await test(95479, 'tv', 1, 1);       // Jujutsu Kaisen S01E01
  await test(37854, 'tv', 1, 1);       // One Piece S01E01
})();
