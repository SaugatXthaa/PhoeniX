// Test all 3 new scrapers directly
'use strict';
const path = require('path');
const projectRoot = path.resolve(__dirname, '..');

async function test(scraperName, scraperFile, tmdbId, type, season, episode) {
  const scraper = require(path.join(projectRoot, 'src', 'nuvio', scraperFile));
  const label = `${scraperName} ${type} ${tmdbId}${season ? ` S${season}E${episode}` : ''}`;
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  try {
    const streams = await Promise.race([
      scraper.getStreams(String(tmdbId), type, season || null, episode || null),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 45s')), 45000)),
    ]);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${(streams || []).length} stream(s)`);
    for (const s of (streams || []).slice(0, 5)) {
      console.log(`  - ${s.name} | q=${s.quality} | type=${s.type || ''}`);
      console.log(`    url=${(s.url || '').slice(0, 100)}`);
    }
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`FAIL [${dt}s] — ${e?.message || e}`);
  }
}

(async () => {
  // HDHub4u
  await test('HDHub4u', 'hdhub4u_v2.cjs', '27205', 'movie');
  await test('HDHub4u', 'hdhub4u_v2.cjs', '872585', 'movie'); // Oppenheimer (4K)
  
  // MoviesHunt
  await test('MoviesHunt', 'movieshunt_v2.cjs', '27205', 'movie');
  
  // MoviesDrive
  await test('MoviesDrive', 'moviesdrive_v2.cjs', '27205', 'movie');
})();
