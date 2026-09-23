// StellarRip relay experiment — run the REAL provider with fetch shim:
// requests to stellar.rip /api/encrypt + opaque stream URLs are routed via
// test.cors.workers.dev (Cloudflare egress, different IP class than Render/DC).
const RELAY = 'https://test.cors.workers.dev/?';
const REAL_FETCH = global.fetch;
let relayCount = 0, directCount = 0;

global.fetch = async function (url, opts = {}) {
  const u = String(url);
  if (u.startsWith('https://stellar.rip/api/encrypt') || /\/api\/stream-encrypted\?data=/.test(u)) {
    relayCount++;
    const r = await REAL_FETCH(RELAY + u, opts);
    return r;
  }
  if (u.includes('stellar.rip')) directCount++;
  return REAL_FETCH(url, opts);
};

const mod = await import('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');
const titles = [
  ['27205', 'movie', null, null, 'Inception'],
  ['693134', 'movie', null, null, 'Dune2'],
];
for (const [id, type, s, e, name] of titles) {
  const t0 = Date.now();
  try {
    const streams = await mod.getStreams(id, type, s, e);
    console.log(`[${name}] ${streams.length} streams in ${Date.now() - t0}ms (relay=${relayCount} direct=${directCount})`);
    for (const st of streams.slice(0, 4)) console.log('  -', (st.name || '').slice(0, 70), '|', (st.url || '').slice(0, 80));
  } catch (err) {
    console.log(`[${name}] ERR ${Date.now() - t0}ms`, err.message);
  }
  await new Promise(r => setTimeout(r, 3000));
}
console.log('TOTAL relay calls:', relayCount, 'direct:', directCount);
