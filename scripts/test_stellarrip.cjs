// Test stellarrip scraper (source + extractor) with movies + TV + anime
'use strict';
const path = require('path');
const projectRoot = path.resolve(__dirname, '..');

// stellarrip.cjs requires './stellar-extractor' — point it at stellarrip-extractor.cjs
// by creating a symlink or by patching the require path. Simplest: copy.
const fs = require('fs');
const srcPath = path.join(projectRoot, 'src', 'nuvio', 'stellarrip.cjs');
const extPath = path.join(projectRoot, 'src', 'nuvio', 'stellarrip-extractor.cjs');

// Create a shim 'stellar-extractor.cjs' that re-exports stellarrip-extractor.cjs
// so stellarrip.cjs's require('./stellar-extractor') works.
const shimPath = path.join(projectRoot, 'src', 'nuvio', 'stellar-extractor.cjs');
if (!fs.existsSync(shimPath)) {
  fs.writeFileSync(shimPath, "module.exports = require('./stellarrip-extractor.cjs');\n");
  console.log('Created shim: src/nuvio/stellar-extractor.cjs');
}

const stellar = require(srcPath);

async function test(tmdbId, type, season, episode) {
  const label = `${type} ${tmdbId}${season ? ` S${season}E${episode}` : ''}`;
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  try {
    const streams = await Promise.race([
      stellar.resolveStreams({
        type: type === 'movie' ? 'movie' : 'series',
        tmdbId: parseInt(tmdbId, 10),
        ...(season ? { season, episode } : {})
      }, { verbose: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 60s')), 60000)),
    ]);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`OK [${dt}s] — ${(streams || []).length} stream(s)`);
    for (const s of (streams || []).slice(0, 6)) {
      console.log(`  - ${s.serverName || s.name} | q=${s.quality || ''} | format=${s.format || ''}`);
      console.log(`    title: ${s.title}`);
      console.log(`    url=${(s.url || '').slice(0, 110)}`);
      if (s.audio) console.log(`    audio: ${s.audio}`);
      if (s.subtitles?.length) console.log(`    subtitles: ${s.subtitles.join(', ')}`);
      if (s.requestHeaders) console.log(`    requestHeaders: ${JSON.stringify(s.requestHeaders).slice(0, 100)}`);
    }
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`FAIL [${dt}s] — ${e?.message || e}`);
    if (e?.stack) console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  }
}

(async () => {
  await test('27205', 'movie');        // Inception
  await test('872585', 'movie');       // Oppenheimer (4K)
  await test('1396', 'series', 1, 1);  // Breaking Bad S01E01
  await test('95479', 'series', 1, 1); // JJK S01E01 (anime)
})();
