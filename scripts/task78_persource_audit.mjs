// Task 78: individual per-source audit — find every NON-WORKING source for
// movies / series / animes, straight from PRODUCTION with real scrapes
// (/debug/source bypasses all caches, so this measures raw source capability).
//
// Method (no guessing, every source individually):
//   pass 1  primary title per category (movie=Dune2, series=SquidGame, anime=JJK)
//   pass 2  every ZERO re-probed with an ALTERNATE title (Inception / Breaking
//           Bad / Frieren) — kills catalog-gap false negatives
//   pass 3  still-zero sources re-probed on the primary title after cooldown —
//           kills transient upstream-window false negatives (desiflix class)
// A source is only labeled NON-WORKING if it failed every chance it got, and
// the failure signature (upstream 5xx / WAF 403 / DNS dead / timeout / clean
// zero) is captured from the server-side logs for the classification.
//
// Phases:
//   --phase=sweep    pass 1 + pass 2 (writes task78_results.json)
//   --phase=confirm  pass 3 re-confirm of decisive zeros (updates the JSON)
//   --phase=report   final classification table + non-working list

const BASE = process.env.PROD_BASE || 'https://ignatiusphoenix.onrender.com';
const OUT = process.env.OUT_FILE
  ? new URL(`./${process.env.OUT_FILE}`, import.meta.url).pathname
  : new URL('./task78_results.json', import.meta.url).pathname;
const CONC = 3, GAP = 300, CLIENT_TMO = 55000;
// Task 83 recheck: chunked invocation — save state after EVERY probe (not just
// per pass) and stop enqueueing new probes once --budget=<sec> elapses, so the
// sweep survives Bash timeouts and resumes where it left off.
const BUDGET_SEC = +(process.argv.find(a => a.startsWith('--budget='))?.split('=')[1] || 0);
const fs = await import('fs');

// Resolver truth (src/utils/StreamResolver.js): anime-only sources are episode
// scrapers — scheduled for series (=anime content) and SKIPPED on movies.
const ANIME_ONLY = new Set([
  'animeflix', 'anineko', 'anikoto', 'anikage', 'anibd', '2dhive',
  'anidoor', 'animegg', 'hianime', 'animekai', 'animesdigital',
  'itachi', 'anikototv', 'animezey', 'animotvslash',
  'allwish', 'animesuge', 'reanime', 'nikastream', 'anichan',
]);
// Multi sources that ALSO carry anime per their registration contracts —
// informational probe (a 0 here is NOT a non-working verdict).
const ANIME_INFO = new Set([
  'streamxtv', 'cinebyrocks', 'atlantic', 'stellarrip', 'stellar',
  'movielinkbd', 'imdbplay', 'raflix', 'hindmovie', 'rivestream',
  'cineby', 'videasy', 'antarctica',
]);

const TITLES = {
  movie1: { rid: 'tmdb:693134', name: 'Dune: Part Two' },
  movie2: { rid: 'tmdb:27205', name: 'Inception' },
  ser1:   { rid: 'tmdb:93405:1:1', name: 'Squid Game S1E1' },
  ser2:   { rid: 'tmdb:1396:1:1', name: 'Breaking Bad S1E1' },
  an1:    { rid: 'tmdb:95479:1:1', name: 'Jujutsu Kaisen S1E1' },
  an2:    { rid: 'tmdb:209867:2:1', name: 'Frieren S2E1' },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jget(path, timeoutMs = CLIENT_TMO) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { signal: ac.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { return { status: res.status, json: null, text: text.slice(0, 300) }; }
  } catch (e) {
    return { status: 0, error: e?.message || String(e) };
  } finally { clearTimeout(t); }
}

// ── registry discovery: production is the authority ──────────────────────
async function productionRegistry() {
  const r = await jget('/debug/source/__registry_probe__', 20000);
  if (r.status !== 404 || !r.json?.error) {
    throw new Error(`registry probe failed: HTTP ${r.status} ${r.text || r.error || ''}`);
  }
  // The Available list is embedded in the 404 error string:
  // {"error":"Source 'X' not found. Available: a, b, c"}
  const m = /Available: (.+)$/.exec(r.json.error);
  if (!m) throw new Error(`cannot parse Available list from: ${r.json.error.slice(0, 120)}`);
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

async function localRegistry() {
  try {
    const mod = await import('../src/source/index.js');
    const { createSources } = mod;
    const sources = createSources(() => ({}));
    return sources.map(s => s.id);
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ── probing ──────────────────────────────────────────────────────────────
function signatureOf(resp) {
  if (!resp) return 'no-response';
  if (resp.status === 0) return `client:${resp.error || 'network'}`;
  if (resp.status === 404) return 'not-found(disabled?)';
  const j = resp.json;
  if (!j) return `http${resp.status}`;
  if (j.error) return `throw:${String(j.error).slice(0, 90)}`;
  if (j.timedOut) return 'timeout(35s)';
  if ((j.count ?? 0) > 0) return 'ok';
  const logs = (j.logs || []).join(' | ').toLowerCase();
  for (const [re, tag] of [
    [/502|503|504|522| bad gateway|service unavailable/, 'upstream-5xx'],
    [/403|forbidden|cloudflare|waf|challenge/, 'waf-403'],
    [/enotfound|eai_again|dns|getaddrinfo/, 'dns-dead'],
    [/etimedout|timeout|aborted|econnreset|econnrefused/, 'conn-fail'],
    [/429|too many/, 'rate-429'],
    [/srl|speedracelight|vidking/, 'vidking-class'],
  ]) if (re.test(logs)) return tag;
  return 'clean-zero';
}

async function probeSource(id, cat, titleKey) {
  const t = TITLES[titleKey];
  const type = (cat === 'movie') ? 'movie' : 'series';
  const t0 = Date.now();
  const r = await jget(`/debug/source/${id}?type=${type}&id=${t.rid}`);
  const dt = Date.now() - t0;
  const j = r.json || {};
  const count = j.count ?? 0;
  return {
    id, cat, titleKey, title: t.name, rid: t.rid,
    count, durationMs: j.durationMs ?? dt, http: r.status,
    timedOut: !!j.timedOut, error: j.error || null,
    sig: signatureOf(r), at: new Date().toISOString(),
    logTail: (j.logs || []).filter(l => /error|fail|502|503|403|429|timeout|refus|denied|down|dead/i.test(l)).slice(-3),
  };
}

// state: Map key `${id}|${cat}` → ARRAY of probe records (full history kept)
function stateGet(state, id, cat) { return state.get(`${id}|${cat}`) || []; }
function bestCount(state, id, cat) { return Math.max(0, ...stateGet(state, id, cat).map(r => r.count)); }

async function runQueue(queue, state, { force = false } = {}) {
  const q = force ? [...queue] : [...queue].filter(job => {
    const done = stateGet(state, job.id, job.cat).some(r => r.titleKey === job.titleKey);
    if (done) console.log(`[skip] ${job.id} ${job.cat} ${job.titleKey} (already probed)`);
    return !done;
  });
  const t0run = Date.now();
  let budgetStop = false;
  const workers = Array.from({ length: CONC }, async () => {
    while (q.length) {
      if (BUDGET_SEC && (Date.now() - t0run) > BUDGET_SEC * 1000) {
        if (!budgetStop) { budgetStop = true; console.log(`[budget] ${BUDGET_SEC}s elapsed — stopping (resume by re-running)`); }
        break;
      }
      const job = q.shift();
      const rec = await probeSource(job.id, job.cat, job.titleKey);
      const arr = stateGet(state, job.id, job.cat);
      arr.push(rec);
      state.set(`${job.id}|${job.cat}`, arr);
      saveState(state); // Task 83: crash/chunk-safe — every probe persisted
      const mark = rec.count > 0 ? '✓' : '✗';
      console.log(`[${job.cat}] ${job.id.padEnd(16)} ${job.titleKey} → ${String(rec.count).padStart(3)} @${(rec.durationMs / 1000).toFixed(1)}s ${mark} ${rec.count > 0 ? '' : rec.sig}`);
      await sleep(GAP);
    }
  });
  await Promise.all(workers);
}

// ── state load/save ──────────────────────────────────────────────────────
function loadState() {
  try { return new Map(JSON.parse(fs.readFileSync(OUT, 'utf8'))); }
  catch { return new Map(); }
}
function saveState(state) {
  fs.writeFileSync(OUT, JSON.stringify([...state.entries()], null, 1));
}

// ── phases ───────────────────────────────────────────────────────────────
const phase = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=sweep').split('=')[1];

if (phase === 'sweep') {
  const prod = await productionRegistry();
  const local = await localRegistry();
  console.log(`production registry: ${prod.length} sources`);
  let drift = [];
  if (Array.isArray(local)) {
    drift = [
      ...prod.filter(id => !local.includes(id)).map(id => `prod-only: ${id}`),
      ...local.filter(id => !prod.includes(id)).map(id => `local-only: ${id}`),
    ];
  } else drift = [`local import failed: ${local.error}`];
  console.log(drift.length ? 'REGISTRY DRIFT:\n  ' + drift.join('\n  ') : 'registry drift: none (prod == local)');

  const state = loadState();
  // ── pass 1: primary titles ──
  const pass1 = [];
  for (const id of prod) {
    if (ANIME_ONLY.has(id)) pass1.push({ id, cat: 'anime', titleKey: 'an1' });
    else {
      pass1.push({ id, cat: 'movie', titleKey: 'movie1' });
      pass1.push({ id, cat: 'series', titleKey: 'ser1' });
      if (ANIME_INFO.has(id)) pass1.push({ id, cat: 'anime-info', titleKey: 'an1' });
    }
  }
  console.log(`\n=== PASS 1: ${pass1.length} primary probes (conc ${CONC}) ===`);
  await runQueue(pass1, state);
  saveState(state);

  // ── pass 2: alternate title for every decisive zero ──
  const pass2 = [];
  for (const id of prod) {
    if (ANIME_ONLY.has(id)) {
      if (bestCount(state, id, 'anime') === 0) pass2.push({ id, cat: 'anime', titleKey: 'an2' });
    } else {
      if (bestCount(state, id, 'movie') === 0) pass2.push({ id, cat: 'movie', titleKey: 'movie2' });
      if (bestCount(state, id, 'series') === 0) pass2.push({ id, cat: 'series', titleKey: 'ser2' });
    }
  }
  console.log(`\n=== PASS 2: ${pass2.length} alternate-title confirms ===`);
  await runQueue(pass2, state);
  saveState(state);
  console.log('\nsweep done →', OUT);
}

else if (phase === 'confirm') {
  const prod = await productionRegistry();
  const state = loadState();
  // pass 3: every DECISIVE zero gets one more chance on the primary title
  // (cooldown already elapsed during the sweep) — transient-window guard.
  const decisiveZero = [];
  for (const id of prod) {
    if (ANIME_ONLY.has(id)) {
      const recs = stateGet(state, id, 'anime').filter(r => ['an1', 'an2'].includes(r.titleKey));
      if (recs.length >= 2 && recs.every(r => r.count === 0)) decisiveZero.push({ id, cat: 'anime', titleKey: 'an1' });
    } else {
      const mv = stateGet(state, id, 'movie').filter(r => ['movie1', 'movie2'].includes(r.titleKey));
      const se = stateGet(state, id, 'series').filter(r => ['ser1', 'ser2'].includes(r.titleKey));
      const mvBoth = ['movie1', 'movie2'].every(k => mv.some(r => r.titleKey === k && r.count === 0));
      const seBoth = ['ser1', 'ser2'].every(k => se.some(r => r.titleKey === k && r.count === 0));
      if (mvBoth) decisiveZero.push({ id, cat: 'movie', titleKey: 'movie1' });
      if (seBoth) decisiveZero.push({ id, cat: 'series', titleKey: 'ser1' });
    }
  }
  console.log(`=== PASS 3 (re-confirm after cooldown): ${decisiveZero.length} probes ===`);
  await runQueue(decisiveZero, state, { force: true });
  saveState(state);
  console.log('confirm done →', OUT);
}

else if (phase === 'report') {
  const prod = await productionRegistry();
  const state = loadState();
  const rows = [];
  for (const id of prod) {
    if (ANIME_ONLY.has(id)) {
      const recs = stateGet(state, id, 'anime');
      const best = bestCount(state, id, 'anime');
      rows.push({ id, kind: 'anime', best, recs, verdict: best > 0 ? 'WORKING' : 'ZERO' });
    } else {
      const mvBest = bestCount(state, id, 'movie');
      const seBest = bestCount(state, id, 'series');
      const aiBest = bestCount(state, id, 'anime-info');
      rows.push({
        id, kind: 'multi', mvBest, seBest, aiBest,
        verdict: (mvBest > 0 || seBest > 0) ? 'WORKING' : 'ZERO',
        mvRecs: stateGet(state, id, 'movie'), seRecs: stateGet(state, id, 'series'),
        aiRecs: stateGet(state, id, 'anime-info'),
      });
    }
  }
  console.log('\n════════ PER-SOURCE VERDICTS ════════');
  const working = [], broken = [];
  for (const r of rows) {
    if (r.kind === 'anime') {
      const line = `${r.id.padEnd(17)} anime=${String(r.best).padStart(3)}  ${r.verdict}`;
      console.log(line);
      (r.verdict === 'WORKING' ? working : broken).push(r);
    } else {
      const line = `${r.id.padEnd(17)} movie=${String(r.mvBest).padStart(3)} series=${String(r.seBest).padStart(3)}${ANIME_INFO.has(r.id) ? ` anime=${String(r.aiBest).padStart(3)}` : '        '}  ${r.verdict}`;
      console.log(line);
      (r.verdict === 'WORKING' ? working : broken).push(r);
    }
  }
  console.log(`\nworking: ${working.length} | zero-class: ${broken.length}`);
  console.log('\n════════ ZERO CLASS DETAIL (all probes + reason signatures) ════════');
  for (const r of broken) {
    if (r.kind === 'anime') {
      const sigs = r.recs.map(x => `${x.titleKey}:${x.count}(${x.sig})`).join('  ');
      console.log(`${r.id} [anime] ${sigs}`);
      r.recs.filter(x => x.logTail?.length).slice(-1).forEach(x => x.logTail.forEach(l => console.log(`    log: ${l.slice(0, 160)}`)));
    } else {
      const ms = r.mvRecs.map(x => `${x.titleKey}:${x.count}(${x.sig})`).join('  ');
      const ss = r.seRecs.map(x => `${x.titleKey}:${x.count}(${x.sig})`).join('  ');
      console.log(`${r.id} [movie] ${ms} | [series] ${ss}`);
      [...r.mvRecs, ...r.seRecs].filter(x => x.logTail?.length).slice(-1).forEach(x => x.logTail.forEach(l => console.log(`    log: ${l.slice(0, 160)}`)));
    }
  }
  // informational anime coverage for multi sources
  const animeInfoRows = rows.filter(r => r.kind === 'multi' && r.aiRecs.length);
  console.log('\n════════ MULTI-SOURCE ANIME COVERAGE (informational) ════════');
  for (const r of animeInfoRows) console.log(`${r.id.padEnd(17)} anime=${String(r.aiBest).padStart(3)}`);
} else {
  console.error('unknown phase');
  process.exit(1);
}
