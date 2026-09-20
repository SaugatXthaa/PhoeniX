// Task 69: local E2E verification of the scheduling fixes.
// Checks:
//  1. Movie resolve: anime-only sources skipped (51 scheduled), early-ship or
//     budget behavior, no 40s+ hangs on warm rounds.
//  2. Series resolve: anime sources still deliver (regression guard).
//  3. Warm round latency (cache path) — must be fast.
//  4. Debug telemetry exposes earlyShip.
const BASE = 'http://127.0.0.1:4598';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function timed(path) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(120000) });
  const d = await res.json();
  return { ms: Date.now() - t0, count: (d.streams || []).length, cache: res.headers.get('cache-control'), json: d };
}

console.log('=== 1. movie cold (tt4154796 Endgame) ===');
const m1 = await timed('/stream/movie/tt4154796.json');
console.log(`r1: ${m1.count} cards in ${(m1.ms / 1000).toFixed(1)}s cache=${m1.cache}`);

console.log('=== 2. movie warm r2 (should be fast + fuller) ===');
const m2 = await timed('/stream/movie/tt4154796.json');
console.log(`r2: ${m2.count} cards in ${(m2.ms / 1000).toFixed(1)}s cache=${m2.cache}`);

console.log('=== 3. movie warm r3 ===');
const m3 = await timed('/stream/movie/tt4154796.json');
console.log(`r3: ${m3.count} cards in ${(m3.ms / 1000).toFixed(1)}s cache=${m3.cache}`);

console.log('=== 4. debug telemetry ===');
const dbg = await timed('/debug/stream?type=movie&id=tt4154796');
console.log(`debug: ${dbg.json.totalStreams} cards in ${(dbg.ms / 1000).toFixed(1)}s partial=${dbg.json.partial} earlyShip=${JSON.stringify(dbg.json.earlyShip)} settled=${(dbg.json.sources || []).length}`);

console.log('=== 5. series cold (Breaking Bad S1E1 — anime+general) ===');
const s1 = await timed('/stream/series/tt0903747:1:1.json');
console.log(`r1: ${s1.count} cards in ${(s1.ms / 1000).toFixed(1)}s cache=${s1.cache}`);

console.log('=== 6. series warm r2 ===');
const s2 = await timed('/stream/series/tt0903747:1:1.json');
console.log(`r2: ${s2.count} cards in ${(s2.ms / 1000).toFixed(1)}s cache=${s2.cache}`);

console.log('=== 7. anime-only sources present in series but absent in movie ===');
const dbgS = await fetch(BASE + '/debug/stream?type=series&id=tt0903747:1:1', { signal: AbortSignal.timeout(120000) }).then(r => r.json());
const idsS = new Set((dbgS.sources || []).map(s => s.id));
const idsM = new Set((dbg.json.sources || []).map(s => s.id));
const animeInMovie = ['hianime', 'animekai', 'animegg', 'anibd', 'anichan', 'animezey'].filter(a => idsM.has(a));
const animeInSeries = ['hianime', 'animekai', 'animegg', 'anibd', 'anichan', 'animezey'].filter(a => idsS.has(a));
console.log(`anime in movie timings (must be 0): ${animeInMovie.length} -> ${animeInMovie.join(',')}`);
console.log(`anime in series timings (must be >0): ${animeInSeries.length} -> ${animeInSeries.join(',')}`);

console.log('=== 8. html-url check on all cards ===');
const all = [...(m3.json.streams || []), ...(s2.json.streams || [])];
const html = all.filter(s => (s.url || '').match(/\.html?(?:$|\?)/i) && !/zxcstream|zorox/.test(s.url)).length;
console.log(`html cards: ${html} (must be 0)`);

console.log('=== 9. subs attach check ===');
const withSubs = all.filter(s => Array.isArray(s.subtitles) && s.subtitles.length > 0).length;
console.log(`cards with subs: ${withSubs}/${all.length}`);
