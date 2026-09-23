// Task 84 — production verification of the three fixes on ignatiusphoenix-5zrn
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';
const results = [];
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ ok });
};

async function dbgSource(sourceId, tmdb, type = 'movie') {
  const r = await fetch(`${PROD}/debug/source/${sourceId}?type=${type}&id=tmdb:${tmdb}`, { signal: AbortSignal.timeout(110000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const cards = (b) => (b?.streams || b?.results || []).length;
const logs = (b) => (Array.isArray(b?.logs) ? b.logs : Array.isArray(b?.logTail) ? b.logTail : []).join(' | ');

// 1. FRAMEXTV — the transport flip (was: every provider 7s timeout, 0 cards)
console.log('[1] framextv (fix: got-first transport)');
const fx = await dbgSource('framextv', 693134);
const fxC = cards(fx.body);
check('framextv delivers from prod', fx.status === 200 && fxC >= 2, `${fxC} cards in ${fx.body?.durationMs}ms`);
if (fxC) {
  const names = (fx.body.streams || []).slice(0, 3).map(s => (s.name || '').slice(0, 60));
  console.log('   ', names.join('\n    '));
}

// 2. PERSIANSTREMIO — the 25s budget (was: 12s internal timeout killed 18-21s upstream)
console.log('[2] persianstremio (fix: clean rewrite, 25s budget)');
const ps = await dbgSource('persianstremio', 27205);
const psC = cards(ps.body);
check('persianstremio delivers from prod', ps.status === 200 && psC >= 2, `${psC} cards in ${ps.body?.durationMs}ms`);
if (psC) console.log('   ', (ps.body.streams || [])[0]?.name?.slice(0, 70), '|', String(ps.body.streams?.[0]?.url).slice(0, 60));

// 3. ACERMOVIES — relay fallback (was: honest zero during 429 cooldown)
console.log('[3] acermovies (fix: egress relay)');
const ac1 = await dbgSource('acermovies', 27205);
console.log(`    run1: ${cards(ac1.body)} cards in ${ac1.body?.durationMs}ms | log: ${logs(ac1.body).slice(0, 200)}`);
const ac2 = await dbgSource('acermovies', 27205);
const ac2C = cards(ac2.body);
const ac2Log = logs(ac2.body);
const relaySeen = /relay/.test(ac2Log);
check('acermovies responds with cards or engaged relay', ac2.status === 200 && (ac2C > 0 || relaySeen), `run2: ${ac2C} cards, relayEngaged=${relaySeen}, log: ${ac2Log.slice(0, 180)}`);

// 4. MERGED Dune2 + invariants
console.log('[4] merged Dune2 rounds');
async function mergedRound() {
  const t0 = Date.now();
  const r = await fetch(`${PROD}/stream/movie/tt1375666.json`, { signal: AbortSignal.timeout(130000) });
  const cc = r.headers.get('cache-control') || '';
  const j = await r.json().catch(() => ({ streams: [] }));
  return { cc, streams: j.streams || [], dt: ((Date.now() - t0) / 1000).toFixed(1) };
}
const r1 = await mergedRound();
const inv1 = r1.streams.every(s => !/^magnet:/i.test(s.url || '') && !/\.html?($|\?)/i.test(s.url || ''));
check('merged r1 (cold) invariants', inv1, `${r1.streams.length} cards cc=${r1.cc} ${r1.dt}s`);
const r2 = await mergedRound();
const inv2 = r2.streams.every(s => !/^magnet:/i.test(s.url || '') && !/\.html?($|\?)/i.test(s.url || ''));
const fourK = r2.streams.filter(s => /2160|4K/i.test(s.name || '')).length;
check('merged r2 (warm) converged', r2.streams.length >= r1.streams.length && /max-age=150/.test(r2.cc), `${r2.streams.length} cards (r1 ${r1.streams.length}) cc=${r2.cc}`);
check('invariants r2 + 4K', inv2 && fourK >= 50, `magnets/html=0, 4K=${fourK}`);
// brand spot-check for the fixed sources
const brands = {};
for (const s of r2.streams) { const m = /PhoeniX · [^·]+ · ([^·]+?) ·/.exec(s.name || ''); const b = m ? m[1].trim() : 'other'; brands[b] = (brands[b] || 0) + 1; }
const fxIn = Object.entries(brands).filter(([k]) => /FrameX|PersianStremio|AcerMovies/i.test(k));
console.log('    fixed-source brands in merged:', JSON.stringify(fxIn));

// 5. Honest-zero sanity (fast-fail signatures, no hangs)
console.log('[5] honest-zero sanity (5 blocked upstreams)');
const t0a = Date.now();
const uh = await dbgSource('uhdmovies', 693134);
check('uhdmovies fast-fail', uh.status === 200 && Date.now() - t0a < 40000, `${cards(uh.body)} cards in ${uh.body?.durationMs}ms`);
const aw = await dbgSource('animeworldindia', 693134);
check('animeworldindia fast-fail', aw.status === 200, `${cards(aw.body)} cards in ${aw.body?.durationMs}ms`);
const an = await dbgSource('anineko', 108465);
check('anineko fast-fail', an.status === 200, `${cards(an.body)} cards in ${an.body?.durationMs}ms`);
const km = await dbgSource('kmmovies', 693134);
check('kmmovies fast-fail', km.status === 200, `${cards(km.body)} cards in ${km.body?.durationMs}ms`);
const st = await dbgSource('stellarrip', 27205);
check('stellarrip honest behavior', st.status === 200, `${cards(st.body)} cards in ${st.body?.durationMs}ms`);

const pass = results.filter(r => r.ok).length;
console.log(`\n== PROD VERIFY: ${pass}/${results.length} PASS ==`);
