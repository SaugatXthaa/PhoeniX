// Comprehensive per-source audit.
// Tests EVERY registered source with appropriate test content:
//   - movie sources → Dune: Part Two (tmdb:693134)
//   - series/TV sources → Breaking Bad S01E01 (tmdb:1396)
//   - anime sources → Naruto S01E01 (tmdb:31910) or Your Name (tmdb:372058)
//
// Each source is tested in a FRESH child process to avoid state contamination
// (require cache, globalThis.fetch overrides, etc.).
//
// Output: per-source status (PASS/FAIL/SKIP) + stream count + sample URL
//
// Usage: node scripts/audit_all_sources_live.mjs [--quick] [--source <id>]
//   --quick          : use 20s timeout instead of 45s
//   --source <id>    : test only one source

import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// ─── Load source registry ──────────────────────────────────────────────
const { createSources } = await import(path.join(PROJECT_ROOT, 'src', 'source', 'index.js'));
const mockFetcher = { json: async () => ({}), head: async () => { throw new Error('mock'); } };
const sources = createSources(mockFetcher);

// ─── Parse CLI args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const quickMode = args.includes('--quick');
const sourceFilterIdx = args.indexOf('--source');
const sourceFilter = sourceFilterIdx >= 0 ? args[sourceFilterIdx + 1] : null;
const timeoutMs = quickMode ? 25000 : 50000;

// ─── Test cases per content type ───────────────────────────────────────
// movie: Dune: Part Two (tmdb:693134, imdb:tt15239678)
// series (non-anime): Breaking Bad (tmdb:1396, S1E1)
// anime: Naruto (tmdb:31910, S1E1) — also Your Name (tmdb:372058) as fallback
const TEST_CASES = {
  movie:  { tmdbId: 693134, type: 'movie', name: 'Dune: Part Two' },
  series: { tmdbId: 1396, type: 'tv', season: 1, episode: 1, name: 'Breaking Bad S01E01' },
  anime:  { tmdbId: 31910, type: 'tv', season: 1, episode: 1, name: 'Naruto S01E01' },
};

// ─── Per-source worker script (runs in child process) ──────────────────
const WORKER_SCRIPT = `
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

// Mock fetcher for TMDB calls
const mockFetcher = {
  json: async (_ctx, url) => {
    const urlStr = url.toString();
    if (urlStr.includes('/movie/')) {
      if (urlStr.includes('/693134')) return { title: 'Dune: Part Two', release_date: '2024-02-27', imdb_id: 'tt15239678', external_ids: { imdb_id: 'tt15239678' } };
      if (urlStr.includes('/372058')) return { title: 'Your Name', release_date: '2016-08-26', imdb_id: 'tt5311514', external_ids: { imdb_id: 'tt5311514' } };
      return { title: 'Test Movie', release_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' } };
    }
    if (urlStr.includes('/tv/')) {
      if (urlStr.includes('/31910')) return { name: 'Naruto', first_air_date: '2002-10-03', imdb_id: 'tt0988824', external_ids: { imdb_id: 'tt0988824' } };
      if (urlStr.includes('/1396')) return { name: 'Breaking Bad', first_air_date: '2008-01-20', imdb_id: 'tt0903747', external_ids: { imdb_id: 'tt0903747' } };
      return { name: 'Test Show', first_air_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' } };
    }
    if (urlStr.includes('/find/')) {
      if (urlStr.includes('tt15239678')) return { movie_results: [{ id: 693134 }] };
      if (urlStr.includes('tt5311514')) return { movie_results: [{ id: 372058 }] };
      if (urlStr.includes('tt0988824')) return { tv_results: [{ id: 31910 }] };
      if (urlStr.includes('tt0903747')) return { tv_results: [{ id: 1396 }] };
      return { movie_results: [], tv_results: [] };
    }
    if (urlStr.includes('providers.json')) return {};
    return {};
  },
  head: async () => { throw new Error('head not mocked'); },
};

const { createSources } = await import(path.join(__dirname, 'src', 'source', 'index.js'));
const sources = createSources(mockFetcher);
const source = sources.find(s => s.id === process.argv[2]);
if (!source) { console.error('Source not found: ' + process.argv[2]); process.exit(2); }

const testCase = JSON.parse(process.argv[3]);
const ctx = { hostUrl: 'http://localhost:11470' };
const id = { id: testCase.tmdbId, ...(testCase.season ? { season: testCase.season, episode: testCase.episode } : {}) };

try {
  const t0 = Date.now();
  const results = await Promise.race([
    source.handleInternal(ctx, testCase.type, id),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ${timeoutMs - 2000})),
  ]);
  const elapsed = Date.now() - t0;
  const count = Array.isArray(results) ? results.length : 0;
  const sample = count > 0 ? (results[0].url?.href || results[0].url || '').slice(0, 100) : '';
  // Output JSON on stdout (logs go to stderr)
  console.log(JSON.stringify({ ok: true, count, elapsed, sample }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message, elapsed: 0 }));
}
`;

// Worker script is a persistent file at scripts/_audit_worker.mjs
const workerPath = path.join(__dirname, '_audit_worker.mjs');

// ─── Determine which test case to use for each source ──────────────────
function pickTestCase(source) {
  // Anime-only sources (contentTypes is ['series'] AND label/name suggests anime)
  const animeOnlySources = new Set([
    'animeflix', 'anidb', 'anineko', 'anikoto', 'anikage', 'anibd', '2dhive',
    'anidoor', 'animegg', 'hianime', 'animekai', 'animezey', 'anikototv',
    'animeworldindia', 'animesdigital', 'itachi', 'reanime', 'anichan',
    'animesuge', 'nikastream',
  ]);
  if (animeOnlySources.has(source.id)) return TEST_CASES.anime;
  // Movie-only sources
  if (source.contentTypes.length === 1 && source.contentTypes[0] === 'movie') return TEST_CASES.movie;
  // Everything else (movie+series) → test with movie first
  return TEST_CASES.movie;
}

// ─── Run tests ─────────────────────────────────────────────────────────
const testList = sourceFilter
  ? sources.filter(s => s.id === sourceFilter)
  : sources;

console.log(`\nAuditing ${testList.length} sources (timeout: ${timeoutMs}ms each)...\n`);

const results = [];
let passCount = 0, failCount = 0, skipCount = 0;
const failures = [];

for (let i = 0; i < testList.length; i++) {
  const source = testList[i];
  const tc = pickTestCase(source);
  process.stdout.write(`[${String(i+1).padStart(2)}/${testList.length}] ${source.id.padEnd(15)} `);

  try {
    // Use stdio: 'pipe' to capture stdout/stderr separately.
    // The worker prints logs to stderr (console.log goes to stderr in child
    // processes when stdout is piped) and the JSON result to stdout.
    const output = execSync(
      `node ${workerPath} ${source.id} '${JSON.stringify(tc)}' ${timeoutMs - 2000} 2>/dev/null`,
      { encoding: 'utf8', timeout: timeoutMs, cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 }
    );
    // Parse last line of stdout (the JSON result)
    const lines = output.trim().split('\n').filter(Boolean);
    const jsonLine = lines[lines.length - 1];
    const result = JSON.parse(jsonLine);

    if (result.ok && result.count > 0) {
      passCount++;
      console.log(`✅ ${String(result.count).padStart(3)} streams (${result.elapsed}ms)`.padEnd(30) + ` ${result.sample.slice(0, 60)}`);
      results.push({ id: source.id, status: 'PASS', count: result.count, elapsed: result.elapsed });
    } else if (result.ok && result.count === 0) {
      failCount++;
      console.log(`⚠️  0 streams (${result.elapsed}ms)`);
      results.push({ id: source.id, status: 'ZERO', count: 0, elapsed: result.elapsed });
      failures.push({ id: source.id, reason: '0 streams', testCase: tc.name });
    } else {
      failCount++;
      console.log(`❌ ERROR: ${result.error?.slice(0, 60) || 'unknown'}`);
      results.push({ id: source.id, status: 'FAIL', error: result.error });
      failures.push({ id: source.id, reason: result.error, testCase: tc.name });
    }
  } catch (e) {
    failCount++;
    const reason = e.killed ? 'TIMEOUT' : (e.message || 'unknown').slice(0, 60);
    console.log(`❌ ${reason}`);
    results.push({ id: source.id, status: 'FAIL', error: reason });
    failures.push({ id: source.id, reason, testCase: tc.name });
  }
}

// ─── Summary ───────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`SUMMARY: ${passCount} PASS, ${failCount} FAIL/SKIP out of ${testList.length} sources`);
console.log(`${'═'.repeat(70)}`);

if (failures.length > 0) {
  console.log(`\nFailed/zero-stream sources:`);
  failures.forEach(f => {
    console.log(`  ❌ ${f.id.padEnd(15)} — ${f.reason.slice(0, 50)} (test: ${f.testCase})`);
  });
}

// Clean up: keep the worker script (persistent for re-runs)
// Write results to JSON for further analysis
const resultsPath = path.join(__dirname, '_audit_results.json');
fs.writeFileSync(resultsPath, JSON.stringify({ timestamp: new Date().toISOString(), results, failures }, null, 2));
console.log(`\nDetailed results: ${resultsPath}`);
