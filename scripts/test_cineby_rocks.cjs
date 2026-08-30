// Test the NEW uploaded cineby.rocks scraper
'use strict';
const path = require('path');
const cineby = require(path.resolve(__dirname, '..', 'src', 'nuvio', 'cineby_rocks.cjs'));

async function test(tmdbId, type, season, episode) {
  const label = `${type} ${tmdbId}${season ? ` S${season}E${episode}` : ''}`;
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  try {
    const streams = await Promise.race([
      cineby.getStreams(String(tmdbId), type, season || null, episode || null),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 60s')), 60000)),
    ]);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${(streams || []).length} stream(s)`);
    // Count by type
    const direct = (streams || []).filter(s => s.type === 'application/vnd.apple.mpegurl' || s.type === 'video/mp4').length;
    const iframe = (streams || []).filter(s => s.type === 'iframe').length;
    console.log(`  Direct playable: ${direct}, Iframe: ${iframe}`);
    for (const s of (streams || []).slice(0, 8)) {
      console.log(`  - ${s.name || ''} | q=${s.quality || ''} | type=${s.type || ''}`);
      console.log(`    url=${(s.url || '').slice(0, 110)}`);
      if (s.behaviorHints?.proxyHeaders) console.log(`    proxyHeaders: yes`);
    }
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`FAIL [${dt}s] — ${e?.message || e}`);
  }
}

(async () => {
  await test(27205, 'movie');         // Inception
  await test(1396, 'tv', 1, 1);       // Breaking Bad S01E01
  await test(95479, 'tv', 1, 1);      // JJK S01E01 (anime)
})();
