// Task 82b: prod-egress A/B probes for stellar.rip — re-run after the user's
// new deployment (ignatiusphoenix-5zrn.onrender.com) restored production.
// Task 82 deferred this exact probe (worklog: "Re-run the prod probes after
// the service is restored").
//
// Vantages:
//   prod-new : ignatiusphoenix-5zrn.onrender.com /debug/rawfetch (Render egress, fresh IP)
//   prod-old : ignatiusphoenix.onrender.com /debug/rawfetch (suspended 503 — documented)
//   local    : this sandbox's DC egress (control; Task 82 proved the chain works here)
//
// Chain steps replayed per vantage (gentle: <=7 requests to stellar.rip):
//   1. egress IP via api.ipify.org            (proves new service = fresh IP)
//   2. GET  /en/watch/embed/movie/27205        (WAF check + latency; the provider's first hop)
//   3. POST /api/request-token                 (token acquisition without cookies)
//   4. POST /api/playback-init                 (PoW challenge; chained requestToken)
//   5. POST /api/playback-init solve           (nonce solved locally)
//   6. GET  /api/dead-sources                  (skip-set endpoint)
//   7. POST /api/encrypt (server s24 only)     (gentle: 1 call, well under the 6/min gate)
//
// Known rawfetch limitation: it does NOT forward set-cookie upstream, so steps
// 4/5/7 may fail on session-cookie binding even when egress is healthy — the
// definitive full-chain proof is /debug/source (task82b_stellarrip_prod_e2e.mjs).
// Every result is reported honestly as egress-signal vs chain-limitation.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { solveBitPoW } = require('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');

const PROD_NEW = 'https://ignatiusphoenix-5zrn.onrender.com';
const PROD_OLD = 'https://ignatiusphoenix.onrender.com';
const STELLAR = 'https://stellar.rip';
const TMDB_ID = 27205; // Inception
const MEDIA_ID = TMDB_ID;
const EMBED_PATH_NO_EN = `/watch/embed/movie/${TMDB_ID}`;
const EMBED_PATH = `/en${EMBED_PATH_NO_EN}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const results = {};

async function jfetch(url, opts = {}, tmo = 30000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(tmo) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  return { status: r.status, text, j };
}

// ---- vantage adapters -------------------------------------------------------
// Each step returns { status, ms, head (300 chars) , parsed? }
async function viaRawfetch(base, step) {
  const q = new URLSearchParams();
  q.set('url', step.url);
  if (step.method) q.set('method', step.method);
  if (step.body) q.set('body', step.body);
  if (step.ct) q.set('ct', step.ct);
  if (step.origin) q.set('origin', step.origin);
  if (step.referer) q.set('referer', step.referer);
  const t0 = Date.now();
  const { status, j } = await jfetch(`${base}/debug/rawfetch?${q}`, {}, 40000);
  if (!j) return { status, ms: Date.now() - t0, head: '', note: 'rawfetch no-json' };
  return {
    status: j.status ?? status,
    ms: j.durationMs ?? (Date.now() - t0),
    head: (j.head || '').slice(0, 300),
    err: j.error || j.cause || undefined,
    bytes: j.bytes,
  };
}

async function viaLocal(step) {
  const t0 = Date.now();
  try {
    const r = await fetch(step.url, {
      method: step.method || 'GET',
      ...(step.body ? { body: step.body } : {}),
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', ...(step.ct ? { 'Content-Type': step.ct } : {}), ...(step.origin ? { Origin: step.origin } : {}), ...(step.referer ? { Referer: step.referer } : {}) },
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t0, head: text.slice(0, 300), bytes: text.length };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, head: '', err: e?.message || String(e) };
  }
}

// ---- chain runner -----------------------------------------------------------
async function runChain(vantageName, adapter) {
  const out = { vantage: vantageName, steps: {} };
  console.log(`\n========== VANTAGE: ${vantageName} ==========`);

  // Step 0: addon itself reachable
  // (caller ensures base URL; rawfetch base implies addon up)

  // 1. egress IP
  {
    const r = await adapter({ url: 'https://api.ipify.org?format=json' });
    const ip = r.head.match(/"ip"\s*:\s*"([0-9a-fA-F.:]+)"/);
    out.egressIp = ip ? ip[1] : null;
    out.steps.egressIp = r;
    console.log(`egress IP : ${out.egressIp || 'unresolvable'} (${r.ms}ms)`);
  }

  // 2. embed GET
  {
    const r = await adapter({ url: STELLAR + EMBED_PATH });
    out.steps.embed = r;
    console.log(`embed GET : ${r.status} in ${r.ms}ms bytes=${r.bytes ?? '?'}${r.err ? ' err=' + r.err : ''}${r.status === 403 ? ' [WAF?]' : ''}`);
  }

  // 3. request-token POST
  let requestToken = null;
  {
    const r = await adapter({
      url: STELLAR + '/api/request-token', method: 'POST',
      body: JSON.stringify({ path: EMBED_PATH_NO_EN, embedPlayback: true }),
      ct: 'application/json', origin: STELLAR, referer: STELLAR + EMBED_PATH,
    });
    const m = /"token"\s*:\s*"([^"]+)"/.exec(r.head || '');
    requestToken = m ? m[1] : null;
    out.steps.requestToken = { ...r, tokenAcquired: !!requestToken };
    console.log(`req-token : ${r.status} in ${r.ms}ms token=${requestToken ? 'YES(' + requestToken.length + 'ch)' : 'no'}${r.err ? ' err=' + r.err : ''}`);
  }

  // 4. playback-init (challenge)
  let challenge = null, challengeId = null, difficulty = null;
  if (requestToken) {
    const r = await adapter({
      url: STELLAR + '/api/playback-init', method: 'POST',
      body: JSON.stringify({ mediaId: MEDIA_ID, mediaType: 'movie', tv_slug: '', requestToken }),
      ct: 'application/json', origin: STELLAR, referer: STELLAR + EMBED_PATH,
    });
    const c = /"challenge"\s*:\s*"([^"]+)"/.exec(r.head || '');
    const cid = /"challengeId"\s*:\s*"([^"]+)"/.exec(r.head || '');
    const dif = /"difficulty"\s*:\s*(\d+)/.exec(r.head || '');
    challenge = c ? c[1] : null; challengeId = cid ? cid[1] : null; difficulty = dif ? +dif[1] : null;
    out.steps.playbackInit = { ...r, challengeFound: !!challenge, truncated: !challenge && /challenge/.test(r.head || '') };
    console.log(`pb-init   : ${r.status} in ${r.ms}ms challenge=${challenge ? 'YES' : (out.steps.playbackInit.truncated ? 'TRUNCATED(head300)' : 'no')}${r.err ? ' err=' + r.err : ''}`);

    // 5. solve + re-POST
    if (challenge && challengeId && difficulty) {
      let nonce = null;
      try { nonce = solveBitPoW(challenge, difficulty); } catch { }
      if (nonce != null) {
        const r2 = await adapter({
          url: STELLAR + '/api/playback-init', method: 'POST',
          body: JSON.stringify({ mediaId: MEDIA_ID, mediaType: 'movie', tv_slug: '', requestToken, pow: { challengeId, nonce: String(nonce) } }),
          ct: 'application/json', origin: STELLAR, referer: STELLAR + EMBED_PATH,
        });
        const st = /"token"\s*:\s*"([^"]+)"/.exec(r2.head || '');
        out.steps.powSolve = { ...r2, streamToken: st ? st[1] : null };
        out.streamToken = st ? st[1] : null;
        console.log(`pow-solve : ${r2.status} in ${r2.ms}ms nonce=${nonce} streamToken=${out.streamToken ? 'YES' : 'no'}${r2.err ? ' err=' + r2.err : ''}`);
      }
    }
  }

  // 6. dead-sources GET
  {
    const r = await adapter({ url: `${STELLAR}/api/dead-sources?mediaId=${MEDIA_ID}&mediaType=movie&tv_slug=`, referer: STELLAR + EMBED_PATH });
    out.steps.deadSources = r;
    console.log(`dead-src  : ${r.status} in ${r.ms}ms head=${(r.head || '').slice(0, 80).replace(/\n/g, '')}${r.err ? ' err=' + r.err : ''}`);
  }

  // 7. encrypt (single, server s24 Spica)
  if (requestToken && out.streamToken) {
    const r = await adapter({
      url: STELLAR + '/api/encrypt', method: 'POST',
      body: JSON.stringify({ data: { mediaId: MEDIA_ID, mediaType: 'movie', tv_slug: '', source: 's24' }, endpoint: 'stream-encrypted', requestToken }),
      ct: 'application/json', origin: STELLAR, referer: STELLAR + EMBED_PATH,
    });
    const u = /"url"\s*:\s*"([^"]+)"/.exec(r.head || '');
    out.steps.encryptS24 = { ...r, opaqueUrl: u ? u[1] : null };
    console.log(`encrypt   : ${r.status} in ${r.ms}ms opaqueUrl=${u ? 'YES' : 'no'} head=${(r.head || '').slice(0, 100).replace(/\n/g, '')}${r.err ? ' err=' + r.err : ''}`);
  } else {
    out.steps.encryptS24 = { skipped: true, reason: 'no chained tokens through cookie-less rawfetch' };
    console.log('encrypt   : SKIPPED (no chained tokens through cookie-less rawfetch — see /debug/source e2e for the full chain)');
  }

  return out;
}

// ---- main -------------------------------------------------------------------
console.log('Task 82b: prod-egress A/B probes for stellar.rip');
console.log(`prod-new=${PROD_NEW}  prod-old=${PROD_OLD}`);

// 0. addon reachability
for (const [name, base] of [['prod-new', PROD_NEW], ['prod-old', PROD_OLD]]) {
  const t0 = Date.now();
  try {
    const r = await jfetch(`${base}/manifest.json`, {}, 25000);
    console.log(`addon ${name}: manifest ${r.status} in ${Date.now() - t0}ms`);
    results[name + '_manifest'] = r.status;
  } catch (e) {
    console.log(`addon ${name}: UNREACHABLE (${e?.message || e}) in ${Date.now() - t0}ms`);
    results[name + '_manifest'] = 0;
  }
}

// Vantage A: new prod
try { results.prodNew = await runChain('prod-new', (s) => viaRawfetch(PROD_NEW, s)); }
catch (e) { console.log('prod-new chain FAILED: ' + (e?.message || e)); results.prodNew = { fatal: String(e?.message || e) }; }

// Vantage B: old prod (suspended?)
try { results.prodOld = await runChain('prod-old', (s) => viaRawfetch(PROD_OLD, s)); }
catch (e) { console.log('prod-old chain FAILED: ' + (e?.message || e)); results.prodOld = { fatal: String(e?.message || e) }; }

// Vantage C: local control
try { results.local = await runChain('local-dc', (s) => viaLocal(s)); }
catch (e) { console.log('local chain FAILED: ' + (e?.message || e)); results.local = { fatal: String(e?.message || e) }; }

// ---- summary ----------------------------------------------------------------
console.log('\n===== A/B SUMMARY =====');
const row = (label, r) => {
  if (!r || r.fatal) return `${label}: FATAL ${r?.fatal || ''}`;
  const s = r.steps || {};
  return [
    `${label}:`,
    `  ip=${r.egressIp || '?'}`,
    `  embed=${s.embed?.status ?? '?'}/${s.embed?.ms ?? '?'}ms`,
    `  reqtok=${s.requestToken?.status ?? '?'}/${s.requestToken?.ms ?? '?'}ms token=${s.requestToken?.tokenAcquired ? 'Y' : 'N'}`,
    `  pbinit=${s.playbackInit?.status ?? 'skip'}`,
    `  pow=${s.powSolve ? (s.powSolve.status + (s.powSolve.streamToken ? '+tok' : '')) : 'skip'}`,
    `  dead=${s.deadSources?.status ?? '?'}`,
    `  enc=${s.encryptS24 ? (s.encryptS24.skipped ? 'skip' : s.encryptS24.status + (s.encryptS24.opaqueUrl ? '+url' : '')) : '?'}`,
  ].join(' ');
};
console.log(row('prod-new', results.prodNew));
console.log(row('prod-old', results.prodOld));
console.log(row('local-dc', results.local));

const fs = await import('fs');
fs.writeFileSync('/home/z/my-project/scripts/task82b_ab_results.json', JSON.stringify(results, null, 2));
console.log('\nSaved: scripts/task82b_ab_results.json');
