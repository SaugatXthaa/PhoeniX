// StellarRip A/B: direct vs relay, alternating titles, same minutes
const RELAY = 'https://test.cors.workers.dev/?';
const REAL_FETCH = global.fetch;
let mode = 'direct';
let stats = { direct: { calls: 0 }, relay: { calls: 0 } };

global.fetch = async function (url, opts = {}) {
  const u = String(url);
  const isEncrypt = u.startsWith('https://stellar.rip/api/encrypt') || /\/api\/stream-encrypted\?data=/.test(u);
  if (isEncrypt) stats[mode].calls++;
  if (isEncrypt && mode === 'relay') return REAL_FETCH(RELAY + u, opts);
  return REAL_FETCH(url, opts);
};

const mod = await import('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');

for (let round = 1; round <= 4; round++) {
  mode = round % 2 === 1 ? 'direct' : 'relay';
  const id = round <= 2 ? '27205' : '693134';
  const name = id === '27205' ? 'Inception' : 'Dune2';
  const t0 = Date.now();
  try {
    const streams = await mod.getStreams(id, 'movie', null, null);
    console.log(`r${round} [${mode}] [${name}]: ${streams.length} streams in ${Date.now() - t0}ms (encrypt calls so far: d=${stats.direct.calls} r=${stats.relay.calls})`);
    if (streams.length) {
      for (const st of streams.slice(0, 3)) console.log('   -', (st.name || '').slice(0, 70));
      // continue testing relay in same window
    }
  } catch (e) { console.log(`r${round} [${mode}] ERR`, e.message); }
  await new Promise(r => setTimeout(r, 5000));
}
