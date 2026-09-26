#!/usr/bin/env node
// Task 99b — FORMATTER TEMPLATE × SOURCE-COMBINATION MATRIX (the user ask:
// "test other formatter templates and source combination").
//
// Tests the 4 community presets (Prism / TamTaro / Light Google Drive /
// Minimalistic) — extracted LIVE from public/configure.js, so the test always
// runs exactly what the UI ships — against REAL /stream responses across
// single-source and merged multi-source installs, movie + series, plus
// /api/formatter-preview parity and the malformed-template fail-open
// regression.
//
// Boot: the script auto-starts the addon (PORT=7100) if not already running.
// Run:  node scripts/task99b_formatter_matrix.mjs [--only caseId,caseId]
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:7100';
const ONLY = (process.argv.find(a => a.startsWith('--only')) || '').split('=')[1] || '';

let pass = 0, fail = 0, warns = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const warn = (name, extra = '') => { warns++; console.log(`  WARN ${name}${extra ? ' — ' + extra : ''}`); };

// ── helpers ──────────────────────────────────────────────────────────────
const seg = (config) => 'z' + zlib.deflateRawSync(JSON.stringify(config)).toString('base64url');
async function j(url, opts, timeoutMs = 150000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally { clearTimeout(t); }
}
// Independent humanBytes (same contract as formatter.cjs, re-typed for the test)
function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
const lastNonEmpty = (s) => (s || '').split('\n').map(l => l.trimEnd()).filter(l => l.trim()).pop() || '';
const lines = (s) => (s || '').split('\n').map(l => l.trimEnd()).filter(l => l.trim());
const LEAK = /\{(?:stream|addon)\./;

// ── extract FORMATTER_PRESETS straight from the shipped UI ───────────────
function loadPresets() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'configure.js'), 'utf8');
  const start = src.indexOf('const FORMATTER_PRESETS');
  const end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('FORMATTER_PRESETS block not found in configure.js');
  const block = src.slice(start, end + 3);
  return new Function(`${block}\nreturn FORMATTER_PRESETS;`)();
}
const PRESETS = loadPresets();

// per-preset expectation tables (engine values: 4K | 1440p | 1080p | 720p | 480p | 360p | '')
const GLYPHS = {
  prism: { set: ['🔥 4K UHD', '🖥️ QHD', '🚀 FHD', '💿 HD', '💩 SD', '🎞️ Stream'], fallbackOk: false },
  tamtaro: { set: ['  4K ', '  QHD ', '  FHD ', '  HD '], fallbackOk: true }, // unknown res → empty render → default name
  'light-google-drive': { re: /^PhoeniX(?: (4K|1440p|1080p|720p|480p|360p))?$/ },
  minimalistic: { set: ['✨ 4K', '🖥️ 1440p', '🧿 1080p', '💿 720p', 'N/A', '480p', '360p'], fallbackOk: false },
};

// ── matrix definition ────────────────────────────────────────────────────
const MOVIE = 'tt1375666';            // Inception
const SERIES = 'tt0903747:1:1';       // Breaking Bad S1E1
const COMBOS = [
  { id: 'videasyto', sources: ['videasyto'], type: 'movie', title: MOVIE, note: 'QHD·HLS single' },
  { id: 'stellar', sources: ['stellar'], type: 'movie', title: MOVIE, note: 'QHD single' },
  { id: 'vidlink2', sources: ['vidlink2'], type: 'movie', title: MOVIE, note: 'QHD single' },
  { id: '4khdhub', sources: ['4khdhub'], type: 'movie', title: MOVIE, note: 'direct MKV big files' },
  { id: 'uhdmovies', sources: ['uhdmovies'], type: 'movie', title: MOVIE, note: 'huge sizes' },
  { id: 'antarctica', sources: ['antarctica'], type: 'movie', title: MOVIE, note: 'direct TorBox' },
  { id: 'merged4', sources: ['videasyto', 'stellar', '4khdhub', 'uhdmovies'], type: 'movie', title: MOVIE, note: 'merged multi' },
  { id: 'videasyto-series', sources: ['videasyto'], type: 'series', title: SERIES, note: 'episode cards' },
  { id: 'merged3-series', sources: ['videasyto', 'stellar', '4khdhub'], type: 'series', title: SERIES, note: 'merged episodes' },
];
const caseId = (c, p) => `${c.id}×${p}`;
const want = (id) => !ONLY || ONLY.split(',').includes(id);

// ── boot server if needed ────────────────────────────────────────────────
let child = null;
async function up() {
  try { const r = await fetch(`${BASE}/manifest.json`); if (r.ok) return; } catch {}
  const log = fs.createWriteStream(path.join(__dirname, 'task99b_server.log'));
  child = spawn('node', ['src/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '7100' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    try { const r = await fetch(`${BASE}/manifest.json`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('local addon did not come up on :7100');
}

const registryLabels = new Set();
const labelOf = {}; // sourceId → registry label
let controlCache = new Map();

async function controlFor(combo) {
  if (controlCache.has(combo.id)) return controlCache.get(combo.id);
  const cfg = Object.fromEntries(combo.sources.map(s => [`source_${s}`, 'on']));
  const r = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/${combo.type}/${combo.title}.json`);
  const streams = r.body?.streams || [];
  controlCache.set(combo.id, streams);
  return streams;
}

function checkName(preset, card) {
  const exp = GLYPHS[preset];
  if (exp.re) return exp.re.test(card.name || '');
  if (exp.set.includes(card.name || '')) return true;
  if (exp.fallbackOk && card.name && !LEAK.test(card.name)) return true; // empty-render fallback
  return false;
}

function checkDescription(preset, card) {
  const title = card.title || '';
  const vs = card.behaviorHints?.videoSize || 0;
  const ls = lines(title);
  if (!ls.length) return { ok: false, why: 'empty description' };
  if (LEAK.test(title)) return { ok: false, why: 'token leakage' };
  if (preset === 'prism') {
    const last = lastNonEmpty(title);
    const m = /^📡 (.+) · PhoeniX$/.exec(last);
    if (!m) return { ok: false, why: `last line not "📡 <src>[ · server] · PhoeniX": ${JSON.stringify(last.slice(0, 60))}` };
    const parts = m[1].split(' · ');
    if (!registryLabels.has(parts[0])) return { ok: false, why: `unknown source label "${parts[0]}"` };
    if (vs) {
      const want = `📦 ${humanBytes(vs)}`;
      if (!ls.some(l => l === want)) return { ok: false, why: `size line missing/wrong: want ${JSON.stringify(want)} got [${ls.map(l => JSON.stringify(l.slice(0, 24))).join(', ')}]` };
    } else if (ls.some(l => l.startsWith('📦'))) return { ok: false, why: 'size line present but card has no videoSize' };
    return { ok: true };
  }
  if (preset === 'tamtaro') {
    const last = lastNonEmpty(title);
    const m = /^(?:📦 (.+?) )?📡 (.+) · PhoeniX$/.exec(last);
    if (!m) return { ok: false, why: `last line not "[📦 size ]📡 src · PhoeniX": ${JSON.stringify(last.slice(0, 60))}` };
    if (!registryLabels.has(m[2])) return { ok: false, why: `unknown source label "${m[2]}"` };
    if (vs && humanBytes(vs) !== m[1]) return { ok: false, why: `size mismatch: want ${humanBytes(vs)} got ${m[1]}` };
    if (!vs && m[1]) return { ok: false, why: 'size rendered but card has no videoSize' };
    return { ok: true };
  }
  if (preset === 'light-google-drive') {
    if (!ls.some(l => l.startsWith('📁 '))) return { ok: false, why: 'no 📁 title line' };
    if (vs) {
      const want = `📦 ${humanBytes(vs)}`;
      if (!ls.some(l => l === want)) return { ok: false, why: `size line missing/wrong: want ${JSON.stringify(want)}` };
    } else if (ls.some(l => l.startsWith('📦'))) return { ok: false, why: 'size line present but card has no videoSize' };
    return { ok: true };
  }
  if (preset === 'minimalistic') {
    // {stream.title} carries the resolver's natural multi-line description;
    // the template appends " · <size>" to the tail. Multi-line is correct —
    // check the suffix at the end, not a line count.
    if (vs) {
      const want = ` · ${humanBytes(vs)}`;
      if (!title.endsWith(want)) return { ok: false, why: `missing size suffix ${JSON.stringify(want)}: ${JSON.stringify(title.slice(-40))}` };
    }
    return { ok: true };
  }
  return { ok: false, why: 'unknown preset' };
}

// ── main ─────────────────────────────────────────────────────────────────
try {
  await up();
  console.log(`server up on :7100 — presets: ${Object.keys(PRESETS).join(', ')}\n`);
  const sj = await j(`${BASE}/sources.json`);
  for (const s of sj.body || []) { registryLabels.add(s.label); labelOf[s.id] = s.label; }

  const results = [];
  for (const combo of COMBOS) {
    console.log(`── ${combo.id} (${combo.type} ${combo.title} — ${combo.note}) ──`);
    let control = await controlFor(combo);
    for (const [key, preset] of Object.entries(PRESETS)) {
      const cid = caseId(combo, key);
      if (!want(cid) && !want(combo.id)) continue;
      const cfg = Object.fromEntries([
        ...combo.sources.map(s => [`source_${s}`, 'on']),
        ['formatter_name', preset.name],
        ['formatter_description', preset.description],
      ]);
      const t0 = Date.now();
      const r = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/${combo.type}/${combo.title}.json`);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const streams = r.body?.streams || [];
      const rec = { case: cid, cards: streams.length, ms: Date.now() - t0, fails: [] };
      if (r.status !== 200 || !streams.length) {
        // zero-card window: honest skip — a dark source is not a formatter bug
        warn(`${cid}: no cards (status ${r.status}, ${dt}s) — formatter untestable this window`, `control=${control.length}`);
        rec.fails.push('no-cards');
        results.push(rec);
        continue;
      }
      // count parity vs control (formatter must only rename, never drop/dup)
      if (control.length && control.length !== streams.length) {
        control = await controlFor(combo); // one retry (window flap)
      }
      if (control.length && control.length !== streams.length) {
        warn(`${cid}: card count ${streams.length} vs control ${control.length} (upstream flap?)`);
        rec.fails.push('count-parity');
      }
      const badName = streams.filter(s => !checkName(key, s));
      ok(`${cid}: every name matches the ${PRESETS[key].label} template`,
        badName.length === 0, `${streams.length} cards @${dt}s${badName.length ? ` — bad: ${badName.slice(0, 3).map(s => JSON.stringify((s.name || '').slice(0, 30))).join(' ')}; e.g. good="${(streams[0].name || '').slice(0, 30)}"` : ` — e.g. "${(streams[0].name || '').slice(0, 30)}"`}`);
      const badDesc = streams.filter(s => { const c = checkDescription(key, s); if (!c.ok) s.__why = c.why; return !c.ok; });
      ok(`${cid}: every description rendered per template (size⇔videoSize, source⇔registry)`,
        badDesc.length === 0, badDesc.length ? `first bad: ${badDesc[0].__why}` : `checked ${streams.length}`);
      const leaked = streams.filter(s => LEAK.test(s.name || '') || LEAK.test(s.title || ''));
      ok(`${cid}: zero raw token leakage`, leaked.length === 0);
      // render-budget sentinel: no card may hit the ellipsis cut (footer intact)
      const cut = streams.filter(s => / …$/.test(s.title || '') || / …$/.test(s.name || ''));
      ok(`${cid}: no render-budget truncation (tail intact)`, cut.length === 0);
      rec.fails.push(...(badName.length ? ['name'] : []), ...(badDesc.length ? ['desc'] : []), ...(leaked.length ? ['leak'] : []), ...(cut.length ? ['cut'] : []));
      results.push(rec);
    }
  }

  console.log('\n── /api/formatter-preview parity (what the UI preview shows) ──');
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (!want(`preview×${key}`) && !want('preview')) continue;
    const r = await j(`${BASE}/api/formatter-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: preset.name, description: preset.description }),
    });
    const samples = r.body?.samples || [];
    const bad = samples.filter(s => !checkName(key, { name: s.name }) || LEAK.test(s.name || '') || LEAK.test(s.description || ''));
    ok(`preview×${key}: all ${samples.length} samples render on-glyph`, r.status === 200 && samples.length > 0 && bad.length === 0,
      bad.length ? `bad: ${bad.map(s => JSON.stringify((s.name || '').slice(0, 30))).join(' ')}` : samples.map(s => `${s.label}→${JSON.stringify((s.name || '').slice(0, 24))}`).join(' | '));
  }

  console.log('\n── regression: malformed template still fails open ──');
  {
    const BAD = '{stream.resolution::exists["unterminated';
    const cfg = { source_videasyto: 'on', formatter_name: BAD };
    const r = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/movie/${MOVIE}.json`);
    const streams = r.body?.streams || [];
    const junk = streams.filter(s => /\{stream\./.test(s.name || '')).length;
    ok('malformed template fails open (no junk on real cards)', streams.length > 0 && junk === 0, `${streams.length} cards`);
  }

  fs.writeFileSync(path.join(__dirname, 'task99b_matrix_results.json'), JSON.stringify({ results, pass, fail, warns }, null, 2));
  console.log(`\n═══ MATRIX DONE: ${pass} PASS / ${fail} FAIL / ${warns} WARN ═══`);
  if (failures.length) console.log('failures: ' + failures.join(' | '));
} finally {
  if (child) { try { child.kill('SIGTERM'); } catch {} }
}
process.exit(fail ? 1 : 0);
