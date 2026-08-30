// Test 4KHDHubOne year-matching fix
'use strict';
const path = require('path');

async function main() {
  const scraper = require(path.resolve(__dirname, '..', 'src', 'nuvio', '4khdhub_one.cjs'));

  // Test cases:
  //   - Moana 2026 (TMDB 1108427) — 4khdhub.one has 2016 + 2024 versions,
  //     but NOT the 2026 live-action remake → should return 0 streams
  //   - Moana 2016 (TMDB 277834) — should match the 2016 page → return streams
  //   - Moana 2 2024 (TMDB 1241982) — should match the 2024 page → return streams
  //   - Inception 2010 (TMDB 27205) — should still work (sanity check)

  const tests = [
    { name: 'Moana 2026 (should return 0 — not on 4khdhub.one)', tmdbId: 1108427, type: 'movie', expectZero: true },
    { name: 'Moana 2016 (should match)', tmdbId: 277834, type: 'movie' },
    { name: 'Moana 2 2024 (should match)', tmdbId: 1241982, type: 'movie' },
    { name: 'Inception 2010 (sanity check)', tmdbId: 27205, type: 'movie' },
  ];

  for (const t of tests) {
    console.log('\n=== ' + t.name + ' ===');
    const t0 = Date.now();
    let streams;
    try {
      streams = await Promise.race([
        scraper.getStreams(t.tmdbId, t.type),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 30s')), 30000)),
      ]);
    } catch (e) {
      console.log('FAIL: ' + e.message);
      continue;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    streams = streams || [];
    console.log('OK [' + dt + 's] — ' + streams.length + ' stream(s)');
    if (t.expectZero && streams.length > 0) {
      console.log('  ❌ FAIL: expected 0 streams but got ' + streams.length);
      for (const s of streams.slice(0, 3)) {
        console.log('    - ' + s.title);
      }
    } else if (t.expectZero) {
      console.log('  ✅ Correctly returned 0 streams (no year match)');
    } else if (streams.length > 0) {
      console.log('  ✅ Got streams:');
      for (const s of streams.slice(0, 3)) {
        console.log('    - ' + s.title);
      }
    } else {
      console.log('  ⚠️  No streams (may be OK if 4khdhub.one is down)');
    }
  }
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
