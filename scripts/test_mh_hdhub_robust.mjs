// Test MoviesHunt and HDHub4u with multiple titles (movies + TV) to verify
// the colon/year fixes are robust.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROJECT_ROOT = path.join(__dirname, '..');

const testCases = [
  // Movies with colons/special chars in title
  { scraper: 'movieshunt_v2', tmdbId: '693134', type: 'movie', name: 'Dune: Part Two (2024)' },
  { scraper: 'hdhub4u_v2', tmdbId: '693134', type: 'movie', name: 'Dune: Part Two (2024)' },
  // Movie without colon
  { scraper: 'movieshunt_v2', tmdbId: '27205', type: 'movie', name: 'Inception (2010)' },
  { scraper: 'hdhub4u_v2', tmdbId: '27205', type: 'movie', name: 'Inception (2010)' },
  // Movie with apostrophe
  { scraper: 'movieshunt_v2', tmdbId: '558', type: 'movie', name: 'Spider-Man 2 (2004)' },
  { scraper: 'hdhub4u_v2', tmdbId: '558', type: 'movie', name: 'Spider-Man 2 (2004)' },
  // TV series
  { scraper: 'movieshunt_v2', tmdbId: '1396', type: 'tv', season: 1, episode: 1, name: 'Breaking Bad S01E01' },
  { scraper: 'hdhub4u_v2', tmdbId: '1396', type: 'tv', season: 1, episode: 1, name: 'Breaking Bad S01E01' },
];

for (const tc of testCases) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TEST: ${tc.scraper} — ${tc.name}`);
  console.log(`${'─'.repeat(60)}`);
  const scraperPath = path.join(PROJECT_ROOT, 'src', 'nuvio', tc.scraper + '.cjs');
  try {
    delete require_.cache[require_.resolve(scraperPath)];
    const mod = require_(scraperPath);
    const t0 = Date.now();
    const streams = await Promise.race([
      mod.getStreams(tc.tmdbId, tc.type, tc.season || null, tc.episode || null),
      new Promise(r => setTimeout(() => r(null), 45000)),
    ]);
    const elapsed = Date.now() - t0;
    if (Array.isArray(streams) && streams.length > 0) {
      console.log(`✅ ${streams.length} streams in ${elapsed}ms`);
      streams.slice(0, 3).forEach((s, i) => {
        const host = (() => { try { return new URL(s.url).hostname; } catch { return '?'; } })();
        console.log(`  ${i+1}. ${s.quality || '?'} @ ${host}`);
      });
    } else {
      console.log(`⚠️  0 streams in ${elapsed}ms`);
    }
  } catch (e) {
    console.log(`❌ Error: ${e.message}`);
  }
}
