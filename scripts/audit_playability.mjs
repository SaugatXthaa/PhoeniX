// Playability audit — tests all 87 sources to verify streams are ACTUALLY
// playable (not just returning URLs). Does a range-GET to each stream URL
// and checks for 200/206 with video content.
//
// Usage: node scripts/audit_playability.mjs [--source <id>] [--quick]

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const workerPath = path.join(__dirname, '_playability_worker.mjs');

// Load source registry
const { createSources } = await import(path.join(PROJECT_ROOT, 'src', 'source', 'index.js'));
const mockFetcher = { json: async () => ({}), head: async () => { throw new Error('mock'); } };
const sources = createSources(mockFetcher);

// Parse args
const args = process.argv.slice(2);
const quickMode = args.includes('--quick');
const sourceFilterIdx = args.indexOf('--source');
const sourceFilter = sourceFilterIdx >= 0 ? args[sourceFilterIdx + 1] : null;
const timeoutMs = quickMode ? 30000 : 60000;

// Test cases
const TEST_CASES = {
  movie:  { tmdbId: 693134, type: 'movie', name: 'Dune: Part Two' },
  series: { tmdbId: 1396, type: 'tv', season: 1, episode: 1, name: 'Breaking Bad S01E01' },
  anime:  { tmdbId: 31910, type: 'tv', season: 1, episode: 1, name: 'Naruto S01E01' },
};

function pickTestCase(source) {
  const animeOnly = new Set([
    'animeflix', 'anidb', 'anineko', 'anikoto', 'anikage', 'anibd', '2dhive',
    'anidoor', 'animegg', 'hianime', 'animekai', 'animezey', 'anikototv',
    'animeworldindia', 'animesdigital', 'itachi', 'reanime', 'anichan',
    'animesuge', 'nikastream', 'antova', 'allwish',
  ]);
  if (animeOnly.has(source.id)) return TEST_CASES.anime;
  if (source.contentTypes.length === 1 && source.contentTypes[0] === 'movie') return TEST_CASES.movie;
  return TEST_CASES.movie;
}

const testList = sourceFilter
  ? sources.filter(s => s.id === sourceFilter)
  : sources;

console.log(`\nPlayability audit: ${testList.length} sources (timeout: ${timeoutMs}ms each)...\n`);

const results = [];
let passCount = 0, failCount = 0, zeroCount = 0;
const failures = [];

for (let i = 0; i < testList.length; i++) {
  const source = testList[i];
  const tc = pickTestCase(source);
  process.stdout.write(`[${String(i+1).padStart(2)}/${testList.length}] ${source.id.padEnd(15)} `);

  try {
    const output = execSync(
      `node ${workerPath} ${source.id} '${JSON.stringify(tc)}' ${timeoutMs - 2000} 2>/dev/null`,
      { encoding: 'utf8', timeout: timeoutMs, cwd: PROJECT_ROOT, maxBuffer: 20 * 1024 * 1024 }
    );
    const lines = output.trim().split('\n').filter(Boolean);
    const jsonLine = lines[lines.length - 1];
    const result = JSON.parse(jsonLine);

    if (!result.ok) {
      failCount++;
      console.log(`❌ ERROR: ${result.error?.slice(0, 50) || 'unknown'}`);
      results.push({ id: source.id, status: 'ERROR', error: result.error });
      failures.push({ id: source.id, reason: result.error });
    } else if (result.total === 0) {
      zeroCount++;
      console.log(`⚠️  0 streams`);
      results.push({ id: source.id, status: 'ZERO', total: 0 });
    } else if (result.playable > 0) {
      passCount++;
      const pct = Math.round(result.playable / result.total * 100);
      console.log(`✅ ${result.playable}/${result.total} playable (${pct}%)`);
      results.push({ id: source.id, status: 'PASS', total: result.total, playable: result.playable });
    } else {
      failCount++;
      console.log(`❌ 0/${result.total} playable`);
      results.push({ id: source.id, status: 'UNPLAYABLE', total: result.total, playable: 0 });
      failures.push({ id: source.id, reason: `0/${result.total} streams playable` });
    }
  } catch (e) {
    failCount++;
    const reason = e.killed ? 'TIMEOUT' : (e.message || 'unknown').slice(0, 50);
    console.log(`❌ ${reason}`);
    results.push({ id: source.id, status: 'FAIL', error: reason });
    failures.push({ id: source.id, reason });
  }
}

// Summary
console.log(`\n${'═'.repeat(70)}`);
console.log(`SUMMARY: ${passCount} PASS, ${failCount} FAIL, ${zeroCount} ZERO out of ${testList.length}`);
console.log(`${'═'.repeat(70)}`);

if (failures.length > 0) {
  console.log(`\nFailed/unplayable sources:`);
  failures.forEach(f => console.log(`  ❌ ${f.id.padEnd(15)} — ${f.reason.slice(0, 50)}`));
}

// Save results
const resultsPath = path.join(__dirname, '_playability_results.json');
fs.writeFileSync(resultsPath, JSON.stringify({ timestamp: new Date().toISOString(), results, failures }, null, 2));
console.log(`\nDetailed results: ${resultsPath}`);
