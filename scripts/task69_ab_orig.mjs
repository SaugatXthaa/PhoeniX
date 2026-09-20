// Task 69: A/B our production vs the original repo deployment, r1 cold-ish,
// same title, plus per-source timing dump via /debug/stream.
const MINE = process.env.PROD_BASE || 'https://ignatiusphoenix.onrender.com';
const ORIG = 'https://phoenix-hgs3.onrender.com';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function hit(base, path) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(120000) });
    const json = await res.json();
    const streams = (json && json.streams) || [];
    return { ms: Date.now() - t0, count: streams.length };
  } catch (e) {
    return { ms: Date.now() - t0, count: -1, error: String(e).slice(0, 100) };
  }
}

const title = process.argv[2] || 'tt6718170'; // fresh-ish title (Spider-Man No Way Home? use passed id)
const path = `/stream/movie/${title}.json`;

console.log('--- MINE ---');
for (let r = 1; r <= 3; r++) {
  const a = await hit(MINE, path);
  console.log(`r${r}: ${a.count} cards in ${(a.ms / 1000).toFixed(1)}s ${a.error || ''}`);
  await sleep(1200);
}
console.log('--- ORIG ---');
for (let r = 1; r <= 3; r++) {
  const a = await hit(ORIG, path);
  console.log(`r${r}: ${a.count} cards in ${(a.ms / 1000).toFixed(1)}s ${a.error || ''}`);
  await sleep(1200);
}
