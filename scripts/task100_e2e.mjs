#!/usr/bin/env node
// Task 100 E2E — the 7 authentic formatter presets (extracted LIVE from
// public/configure.js) rendered against REAL /stream responses across single-
// source and merged installs, movie + series. Plus /api/formatter-preview
// parity, malformed fail-open regression, and the legacy template shape
// (stream.provider / stream.fullTitle extensions) still working.
// Boot: auto-starts the addon on :7100 when not already running.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:7100';
let pass = 0, fail = 0, warns = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ' — ' + e : ''}`); } else { fail++; console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`); } };
const warn = (n, e = '') => { warns++; console.log(`  WARN ${n}${e ? ' — ' + e : ''}`); };

const seg = (c) => 'z' + zlib.deflateRawSync(JSON.stringify(c)).toString('base64url');
async function j(url, opts, timeoutMs = 150000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { ...opts, signal: ctl.signal }); return { status: r.status, body: await r.json().catch(() => null) }; }
  finally { clearTimeout(t); }
}
const JUNK = /invalid_expression|unknown_variableType|unknown_propertyName|unknown_(?:string|number|array|boolean|object)_modifier|cannot_coerce_boolean|unrenderable_list|unable_to_compare|\{(?:stream|addon|service|metadata|user|config|debug|tools)\./;

// presets straight from the shipped UI
const src = fs.readFileSync(path.join(ROOT, 'public', 'configure.js'), 'utf8');
const pStart = src.indexOf('const FORMATTER_PRESETS');
const pEnd = src.indexOf('\n};', pStart);
const PRESETS = new Function(src.slice(pStart, pEnd + 3) + '; return FORMATTER_PRESETS;')();

const PRISM_GLYPHS = ['🔥4K UHD', '✨ QHD', '🚀 FHD', '💿 HD', '💩 Low Quality', '💩 Unknown'];
const MINI_GLYPHS = ['✨ 4K', '📀 2K', '🧿1080p', '💿720p', 'N/A'];
const TAMTARO_RES = ['   4K ', '    2K '];

const MOVIE = 'tt1375666';
const SERIES = 'tt0903747:1:1';
const COMBOS = [
  { id: 'videasyto', sources: ['videasyto'], type: 'movie', title: MOVIE },
  { id: '4khdhub', sources: ['4khdhub'], type: 'movie', title: MOVIE },
  { id: 'uhdmovies', sources: ['uhdmovies'], type: 'movie', title: MOVIE },
  { id: 'antarctica', sources: ['antarctica'], type: 'movie', title: MOVIE },
  { id: 'merged4', sources: ['videasyto', 'stellar', '4khdhub', 'uhdmovies'], type: 'movie', title: MOVIE },
  { id: 'videasyto-series', sources: ['videasyto'], type: 'series', title: SERIES },
];

let child = null;
async function up() {
  try { const r = await fetch(`${BASE}/manifest.json`); if (r.ok) return; } catch {}
  const log = fs.createWriteStream(path.join(__dirname, 'task100_server.log'));
  child = spawn('node', ['src/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '7100' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    try { const r = await fetch(`${BASE}/manifest.json`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('addon did not come up');
}

try {
  await up();
  console.log(`server up — presets: ${Object.keys(PRESETS).join(', ')}\n`);
  const controlCache = new Map();
  async function controlFor(combo) {
    if (controlCache.has(combo.id)) return controlCache.get(combo.id);
    const cfg = Object.fromEntries(combo.sources.map(s => [`source_${s}`, 'on']));
    const r = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/${combo.type}/${combo.title}.json`);
    const streams = r.body?.streams || [];
    controlCache.set(combo.id, streams);
    return streams;
  }

  for (const combo of COMBOS) {
    console.log(`── ${combo.id} (${combo.type} ${combo.title}) ──`);
    let control = await controlFor(combo);
    for (const [key, preset] of Object.entries(PRESETS)) {
      const cid = `${combo.id}×${key}`;
      const cfg = Object.fromEntries([
        ...combo.sources.map(s => [`source_${s}`, 'on']),
        ['formatter_name', preset.name],
        ['formatter_description', preset.description],
      ]);
      const t0 = Date.now();
      const r = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/${combo.type}/${combo.title}.json`);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const streams = r.body?.streams || [];
      if (r.status !== 200 || !streams.length) { warn(`${cid}: no cards (${r.status}) — untestable window`); continue; }
      if (control.length && control.length !== streams.length) control = await controlFor(combo);
      if (control.length && control.length !== streams.length) warn(`${cid}: count ${streams.length} vs control ${control.length} (flap)`);
      const junk = streams.filter(s => JUNK.test(s.name || '') || JUNK.test(s.title || ''));
      ok(`${cid}: zero engine-error tokens / unrendered fields`, junk.length === 0, `${streams.length} cards @${dt}s${junk.length ? ` — ${JSON.stringify((junk[0].name || junk[0].title || '').slice(0, 60))}` : ''}`);
      const fallbacks = streams.filter(s => (s.name || '') === (control[streams.indexOf(s)]?.name || '\u0000'));
      // fallback-to-default is legal only when the template renders empty
      // (tamtaro unknown-res branch); flag wholesale fallbacks as soft
      const fallbackRate = streams.length ? fallbacks.length / streams.length : 0;
      if (fallbackRate > 0.9) warn(`${cid}: ${(fallbackRate * 100).toFixed(0)}% cards kept default naming (template rendered empty?)`);
      // preset-specific glyph checks on the NAME
      if (key === 'prism') {
        const off = streams.filter(s => !PRISM_GLYPHS.includes((s.name || '').trim()));
        ok(`${cid}: prism names on-glyph`, off.length === 0, off.length ? `bad: ${JSON.stringify((off[0].name || '').slice(0, 30))}` : `e.g. "${(streams[0].name || '').trim()}"`);
      }
      if (key === 'minimalisticgdrive') {
        const off = streams.filter(s => !MINI_GLYPHS.includes((s.name || '').split('\n')[0].trim()) && !(s.name || '').startsWith('480p') && !(s.name || '').startsWith('360p'));
        ok(`${cid}: minimalistic names on-glyph`, off.length === 0, off.length ? `bad: ${JSON.stringify((off[0].name || '').slice(0, 30))}` : `e.g. "${(streams[0].name || '').split('\n')[0].trim()}"`);
      }
      if (key === 'torrentio') {
        const off = streams.filter(s => !/PhoeniX (4K|2160p|1440p|1080p|720p|480p|360p|Unknown|\d+p)/.test(s.name || ''));
        ok(`${cid}: torrentio names = "PhoeniX <resolution>"`, off.length === 0, off.length ? `bad: ${JSON.stringify((off[0].name || '').slice(0, 40))}` : `e.g. "${(streams[0].name || '').slice(0, 30)}"`);
      }
      if (key === 'torbox') {
        const prefix = /^(🕵️‍♂️ |🔑 |\[P2P\] )*/;
        const off = streams.filter(s => { const stripped = (s.name || '').trim().replace(/^\s+/, ''); return !prefix.test(stripped) || !/^PhoeniX( \(\s*(2160p|1440p|1080p|720p|480p|360p|Unknown)\s*\))?$/.test(stripped.replace(prefix, '')); });
        ok(`${cid}: torbox names = "[prefix] PhoeniX (resolution)"`, off.length === 0, off.length ? `bad: ${JSON.stringify((off[0].name || '').slice(0, 40))}` : `e.g. "${(streams[0].name || '').trim()}"`);
      }
      if (key === 'lightgdrive') {
        const off = streams.filter(s => !/^🕵️ |^🔑 |^\[P2P\] /.test(s.name || '') ? !/^PhoeniX( (2160p|1440p|1080p|720p|480p|360p))?( |$)/.test((s.name || '').trim()) : !/^PhoeniX( (2160p|1440p|1080p|720p|480p|360p))?( |$)/.test((s.name || '').trim().replace(/^🕵️ |^🔑 |^\[P2P\] /, '')));
        ok(`${cid}: lightgdrive names = "[prefix] PhoeniX [resolution]"`, off.length === 0, off.length ? `bad: ${JSON.stringify((off[0].name || '').slice(0, 40))}` : `e.g. "${(streams[0].name || '').trim().slice(0, 30)}"`);
      }
    }
  }

  console.log('\n── /api/formatter-preview parity (all 7 presets) ──');
  for (const [key, preset] of Object.entries(PRESETS)) {
    const r = await j(`${BASE}/api/formatter-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: preset.name, description: preset.description }) });
    const samples = r.body?.samples || [];
    const junk = samples.filter(s => JUNK.test(s.name || '') || JUNK.test(s.description || ''));
    ok(`preview×${key}: ${samples.length} samples junk-free`, r.status === 200 && samples.length >= 4 && junk.length === 0, samples.map(s => `${s.label}→${JSON.stringify((s.name || '').split('\n')[0].slice(0, 22))}`).join(' | '));
  }

  console.log('\n── legacy template shapes still work (backward compat) ──');
  {
    const cfg = { source_videasyto: 'on', formatter_name: 'PX {stream.resolution}', formatter_description: 'old {stream.fullTitle}' };
    const r = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/movie/${MOVIE}.json`);
    const streams = r.body?.streams || [];
    const badName = streams.filter(s => !/^PX (4K|1440p|1080p|720p|480p|360p|2160p)$/.test(s.name || ''));
    ok('legacy name template with new resolution value renders', streams.length > 0 && badName.length === 0, `${streams.length} cards, e.g. "${streams[0]?.name}"`);
    const badDesc = streams.filter(s => !(s.title || '').startsWith('old '));
    ok('stream.fullTitle extension field works', badDesc.length === 0, `e.g. "${(streams[0]?.title || '').slice(0, 40)}"`);
  }
  {
    const BAD = '{stream.resolution::exists["unterminated';
    const cfg = { source_videasyto: 'on', formatter_name: BAD };
    const r = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/movie/${MOVIE}.json`);
    const streams = r.body?.streams || [];
    const junk = streams.filter(s => JUNK.test(s.name || ''));
    ok('malformed template fails open on real cards', streams.length > 0 && junk.length === 0, `${streams.length} cards`);
  }

  fs.writeFileSync(path.join(__dirname, 'task100_e2e_results.json'), JSON.stringify({ pass, fail, warns }, null, 2));
  console.log(`\n═══ E2E: ${pass} PASS / ${fail} FAIL / ${warns} WARN ═══`);
} finally {
  if (child) { try { child.kill('SIGTERM'); } catch {} }
}
process.exit(fail ? 1 : 0);
