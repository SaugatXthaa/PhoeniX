// Task 69: detect process restarts (OOM/crash/spin-down) via /health uptime,
// while generating resolve load.
const BASE = 'https://ignatiusphoenix.onrender.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastUptime = 0, lastSeen = Date.now(), restarts = 0;
const t0 = Date.now();

async function check() {
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(30000) });
    const d = await res.json();
    return d.uptime;
  } catch { return null; }
}

// Interleave load: 3 resolve rounds on different titles during the watch.
const loadTitles = ['tt15239678', 'tt9362722', 'tt10648342']; // Dune2, Spider-Verse2, Oppenheimer... (approx)
let loadIdx = 0;
let loadDone = 0;

const loadLoop = (async () => {
  for (const t of loadTitles) {
    try {
      const ts = Date.now();
      const res = await fetch(`${BASE}/stream/movie/${t}.json`, { signal: AbortSignal.timeout(120000) });
      const d = await res.json();
      loadDone++;
      console.log(`[load ${loadDone}] ${t}: ${d.streams.length} cards in ${((Date.now() - ts) / 1000).toFixed(1)}s`);
    } catch (e) {
      loadDone++;
      console.log(`[load ${loadDone}] ${t}: ERR ${String(e).slice(0, 60)}`);
    }
  }
})();

while (Date.now() - t0 < 300000) {
  const up = await check();
  const now = Date.now();
  if (up !== null) {
    const wall = (now - lastSeen) / 1000;
    if (lastUptime > 0 && up < lastUptime) {
      restarts++;
      console.log(`!!! RESTART detected: uptime ${lastUptime.toFixed(0)}s → ${up.toFixed(0)}s (wall ${wall.toFixed(0)}s)`);
    }
    lastUptime = up; lastSeen = now;
    console.log(`[${((now - t0) / 1000).toFixed(0)}s] uptime=${up.toFixed(0)}s`);
  } else {
    console.log(`[${((now - t0) / 1000).toFixed(0)}s] /health unreachable`);
  }
  await sleep(20000);
}
await loadLoop;
console.log('total restarts observed:', restarts);
