// Task 69: measure per-round card counts on production to quantify
// "fewer streams than before" + "need 4-5 refreshes".
const BASE = process.env.PROD_BASE || 'https://ignatiusphoenix.onrender.com';
const ID = process.env.PROBE_ID || 'tt1160419'; // Dune (2021)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function hit(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(120000) });
    const json = await res.json();
    const ms = Date.now() - t0;
    const streams = (json && json.streams) || [];
    return { ms, count: streams.length, streams, status: res.status };
  } catch (e) {
    return { ms: Date.now() - t0, count: -1, streams: [], error: String(e).slice(0, 120), status: 0 };
  }
}

function breakdown(streams) {
  const bySource = {};
  for (const s of streams) {
    const m = /phoenix-([a-z0-9_]+)-/i.exec(s.behaviorHints?.bingeGroup || '') || [null, 'unknown'];
    const name = (s.name || '').split('·')[1]?.trim() || m[1];
    bySource[name] = (bySource[name] || 0) + 1;
  }
  return Object.entries(bySource).sort((a, b) => b[1] - a[1]);
}

const isSeries = ID.includes(':');
const path = isSeries
  ? `/stream/series/${ID.replace(':', ':')}.json`
  : `/stream/movie/${ID}.json`;

const rounds = parseInt(process.env.PROBE_ROUNDS || '5', 10);
for (let r = 1; r <= rounds; r++) {
  const { ms, count, streams, error } = await hit(path);
  const b = breakdown(streams).slice(0, 14).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`r${r} ${count} cards in ${ms}ms ${error ? 'ERR=' + error : ''}`);
  if (count > 0) console.log(`   ${b}`);
  if (r < rounds) await sleep(1500);
}
