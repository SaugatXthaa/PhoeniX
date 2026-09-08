// Test ctgmovies.cjs and persianstremio.cjs scrapers to see if they return streams
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROJECT_ROOT = path.join(__dirname, '..');

const scrapers = [
  { name: 'ctgmovies', tmdbId: '693134', type: 'movie', label: 'Dune: Part Two (movie)' },
  { name: 'ctgmovies', tmdbId: '1396', type: 'tv', season: 1, episode: 1, label: 'Breaking Bad S01E01 (tv)' },
  { name: 'persianstremio', tmdbId: '693134', type: 'movie', label: 'Dune: Part Two (movie)' },
  { name: 'persianstremio', tmdbId: '1396', type: 'tv', season: 1, episode: 1, label: 'Breaking Bad S01E01 (tv)' },
];

for (const tc of scrapers) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TEST: ${tc.name} — ${tc.label}`);
  console.log(`${'─'.repeat(60)}`);
  const scraperPath = path.join(PROJECT_ROOT, 'src', 'nuvio', tc.name + '.cjs');
  try {
    delete require_.cache[require_.resolve(scraperPath)];
    const mod = require_(scraperPath);
    if (typeof mod.getStreams !== 'function') {
      console.log(`❌ No getStreams export. Exports: ${Object.keys(mod).join(', ')}`);
      continue;
    }
    const t0 = Date.now();
    const streams = await Promise.race([
      mod.getStreams(tc.tmdbId, tc.type, tc.season || null, tc.episode || null),
      new Promise(r => setTimeout(() => r(null), 30000)),
    ]);
    const elapsed = Date.now() - t0;
    if (Array.isArray(streams) && streams.length > 0) {
      console.log(`✅ ${streams.length} streams in ${elapsed}ms`);
      streams.slice(0, 5).forEach((s, i) => {
        const host = (() => { try { return new URL(s.url).hostname; } catch { return '?'; } })();
        console.log(`  ${i+1}. ${s.quality || '?'} @ ${host} — ${String(s.url).slice(0, 80)}`);
      });
    } else {
      console.log(`⚠️  0 streams in ${elapsed}ms`);
    }
  } catch (e) {
    console.log(`❌ Error: ${e.message}`);
  }
}
