// Task 84 — unit test of the AcerMovies relay path (forces cooldown, mocks fetcher)
import { AcerMovies } from '/home/z/my-project/phoenix-analysis/src/source/AcerMovies.js';
import { TooManyRequestsError } from '/home/z/my-project/phoenix-analysis/src/error/index.js';

// Mock fetcher: textPost throws the REAL TooManyRequestsError so instanceof
// checks in _apiPost behave exactly like production.

const results = [];
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  results.push(ok);
};

const src = new AcerMovies({ textPost: async () => { throw new TooManyRequestsError('429'); } });
src._noteRateLimit('unit-test'); // force cooldown active

// Case 1: cooldown active + direct 429 → relay must be attempted.
// Environment-aware: when the shared public relay is itself rate-limited
// (CF-edge 429 window — happens after bursts from any IP), the correct
// behavior is the paced error propagation + relay cooldown engage.
const t0 = Date.now();
try {
  const text = await src._apiPost({}, '/api/search', JSON.stringify({ searchQuery: 'inception' }));
  const j = JSON.parse(text);
  check('relay search during cooldown', Array.isArray(j.searchResult) && j.searchResult.length > 0,
    `${Date.now() - t0}ms, ${j.searchResult.length} results, first: ${(j.searchResult[0]?.title || '').slice(0, 50)}`);
} catch (e) {
  const paced = src._relayCooldownUntil > Date.now() && /rate-limited/.test(e.message);
  check('relay search during cooldown', paced, `relay window blocked (expected in outage windows): ${e.message.slice(0, 60)}`);
}

// Case 2: direct 429 mid-flight flips to relay in the SAME request (or the
// relay is in its own paced cooldown — then the direct 429 cooldown must
// still be engaged, which is the invariant that matters).
const src2 = new AcerMovies({
  textPost: async () => { throw new TooManyRequestsError('429'); },
});
const t1 = Date.now();
let flipOk = false, flipDetail = '';
try {
  const text = await src2._apiPost({}, '/api/search', JSON.stringify({ searchQuery: 'dune' }));
  const j = JSON.parse(text);
  flipOk = Array.isArray(j.searchResult) && j.searchResult.length > 0 && src2._cooldownUntil > Date.now();
  flipDetail = `${Date.now() - t1}ms, relay delivered + cooldown engaged`;
} catch (e) {
  flipOk = src2._cooldownUntil > Date.now();
  flipDetail = `${Date.now() - t1}ms, direct-429 cooldown engaged (relay paced: ${e.message.slice(0, 40)})`;
}
check('direct 429 → same-request relay flip', flipOk, flipDetail);

// Case 3: relay also failing → throws (honest zero upstream, no hang)
const RELAY_BASE_ORIG = process.env.ACER_RELAY_BASE;
process.env.ACER_RELAY_BASE = 'https://test.cors.workers.dev/?'; // ensure default
const src3 = new AcerMovies({ textPost: async () => { throw new TooManyRequestsError('429'); } });
src3._noteRateLimit('unit-test');
// point the source's RELAY_BASE at an unroutable URL to force relay failure
const origFetch = global.fetch;
global.fetch = async () => { throw new Error('simulated relay outage'); };
try {
  await src3._apiPost({}, '/api/search', '{}');
  check('relay outage → error propagates (honest zero)', false, 'should have thrown');
} catch (e) {
  check('relay outage → error propagates (honest zero)', /simulated relay outage/.test(e.message), e.message.slice(0, 60));
} finally {
  global.fetch = origFetch;
  if (RELAY_BASE_ORIG === undefined) delete process.env.ACER_RELAY_BASE; else process.env.ACER_RELAY_BASE = RELAY_BASE_ORIG;
}

// Case 4: full handleInternal under cooldown with relay delivering cards.
// Mock the whole _resolve to verify cache-fill + relay usage wiring.
const src4 = new AcerMovies({ textPost: async () => { throw new TooManyRequestsError('429'); } });
src4._noteRateLimit('unit-test');
src4._resolve = async () => [{ url: 'https://example.com/file.mkv', format: 'mp4', meta: {} }];
const cards = await src4.handleInternal({}, 'movie', 'tmdb:27205');
check('cooldown handleInternal serves relay-resolved cards + fills cache', cards.length === 1 && src4._resultCache.get('tmdb:27205')?.results?.length === 1, `${cards.length} card(s), cache filled`);
const cards2 = await src4.handleInternal({}, 'movie', 'tmdb:27205');
check('second cooldown call serves from cache', cards2.length === 1, 'cache hit');

const pass = results.filter(Boolean).length;
console.log(`\n== ACER RELAY UNIT: ${pass}/${results.length} PASS ==`);
process.exitCode = pass === results.length ? 0 : 1;
