// Task 69: detect multi-instance load balancing: a title just resolved on
// one instance (cached). If requests alternate fast(cached)/slow(cold),
// we're hitting multiple instances.
const BASE = 'https://ignatiusphoenix.onrender.com';
const path = '/debug/stream?type=movie&id=tt6718170';

for (let i = 1; i <= 6; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(120000) });
    const d = await res.json();
    const ms = Date.now() - t0;
    // A warm instance answers a fully-cached resolve in ~1-5s with partial=false.
    console.log(`req${i}: ${ms}ms streams=${d.totalStreams} partial=${d.partial} settled=${(d.sources || []).length}`);
  } catch (e) {
    console.log(`req${i}: ERR ${String(e).slice(0, 80)}`);
  }
}
