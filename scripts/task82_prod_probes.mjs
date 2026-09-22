// Task 82 — production-egress probes for StellarRip recheck + videasy/vidking status.
// Runs FROM the local machine but every data point comes from PRODUCTION
// (ignatiusphoenix.onrender.com /debug/rawfetch + /debug/source), so it measures
// the same egress IP the addon serves from.
//
// Usage: node scripts/task82_prod_probes.mjs

const BASE = process.argv[2] || 'https://ignatiusphoenix.onrender.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function rawfetch(label, url, extra = '') {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/debug/rawfetch?url=${encodeURIComponent(url)}${extra}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (j.error) console.log(`[prod:${label}] ERROR @${dt}s ${j.error} (cause: ${j.cause || '-'})`);
    else console.log(`[prod:${label}] HTTP ${j.status} @${dt}s (${j.bytes}B, final=${j.finalUrl?.slice(0, 60)}) head=${(j.head || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    return j;
  } catch (e) {
    console.log(`[prod:${label}] probe-fail ${e.message.slice(0, 80)}`);
    return null;
  }
}

async function dbgSource(label, sourceId, tmdb, type = 'movie') {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/debug/source/${sourceId}?type=${type}&id=tmdb:${tmdb}`, { signal: AbortSignal.timeout(90000) });
    const j = await r.json();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const n = (j.streams || j.results || []).length;
    const logs = (j.logs || []).slice(-8).map(l => String(l).replace(/\s+/g, ' ').slice(0, 110));
    console.log(`[prod:src ${label}] ${r.status} cards=${n} @${dt}s durationMs=${j.durationMs ?? '?'}`);
    for (const l of logs) console.log('    log: ' + l);
    return j;
  } catch (e) {
    console.log(`[prod:src ${label}] probe-fail ${e.message.slice(0, 80)}`);
    return null;
  }
}

(async () => {
  console.log(`=== PROD-EGRESS PROBES @ ${BASE} ===`);

  console.log('\n-- StellarRip front-door (prod egress) --');
  await rawfetch('stellar embed', 'https://stellar.rip/en/watch/embed/movie/27205');
  await rawfetch('stellar req-token POST', 'https://stellar.rip/api/request-token',
    '&method=POST&body=' + encodeURIComponent(JSON.stringify({ path: '/watch/embed/movie/27205', embedPlayback: true })) +
    '&ct=application/json&origin=' + encodeURIComponent('https://stellar.rip') +
    '&referer=' + encodeURIComponent('https://stellar.rip/en/watch/embed/movie/27205'));

  console.log('\n-- videasy/vidking chain (prod egress) --');
  await rawfetch('SRL seed', 'https://api.speedracelight.com/seed?mediaId=27205');
  await rawfetch('vidking.net', 'https://vidking.net/');
  await rawfetch('www.vidking.net', 'https://www.vidking.net/');

  console.log('\n-- /debug/source current status --');
  await dbgSource('stellarrip/Inception', 'stellarrip', 27205);
  await dbgSource('stellarrip/Dune2', 'stellarrip', 693134);
  await dbgSource('videasy/Inception', 'videasy', 27205);
  await dbgSource('videasyto/Inception', 'videasyto', 27205);
  await dbgSource('cineby/Inception', 'cineby', 27205);
})().catch(e => console.error('FATAL', e));
