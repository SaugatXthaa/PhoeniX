// Test the existing cineby.cjs scraper to see if it still works.
'use strict';

const path = require('path');
const cineby = require(path.resolve(__dirname, '..', 'src', 'nuvio', 'cineby.cjs'));

async function test(tmdbId, type, season, episode) {
  const label = `${type} ${tmdbId}${season ? ` S${season}E${episode}` : ''}`;
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  try {
    const streams = await Promise.race([
      cineby.getStreams(String(tmdbId), type, season || null, episode || null),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 35s')), 35000)),
    ]);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${(streams || []).length} stream(s)`);
    for (const s of (streams || []).slice(0, 6)) {
      console.log(`  - ${s.name || ''} | q=${s.quality || ''} | type=${s.type || ''}`);
      console.log(`    url=${(s.url || '').slice(0, 110)}`);
      if (s.headers) console.log(`    headers=${JSON.stringify(s.headers).slice(0, 120)}`);
      if (s.subtitles) console.log(`    subtitles=${s.subtitles.length}`);
    }
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`FAIL [${dt}s] — ${e?.message || e}`);
  }
}

(async () => {
  await test(27205, 'movie');         // Inception
  await test(1396, 'tv', 1, 1);       // Breaking Bad S01E01
})();
