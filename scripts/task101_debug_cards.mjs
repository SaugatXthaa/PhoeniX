#!/usr/bin/env node
// Task 101 debug: run the suite's description checks against real cards and
// print every offender with its raw description.
import zlib from 'node:zlib';
import fs from 'node:fs';

const BASE = 'http://localhost:7100';
const src = fs.readFileSync('public/configure.js', 'utf8');
const code = src.slice(src.indexOf('const FORMATTER_PRESETS'), src.indexOf('function detectFormatterPreset'));
const PRESETS = new Function(code + '; return FORMATTER_PRESETS;')();
const seg = (c) => 'z' + zlib.deflateRawSync(JSON.stringify(c)).toString('base64url');
const humanBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};
const lines = (s) => (s || '').split('\n').map(l => l.trimEnd()).filter(l => l.trim());
const LEAK = /\{(?:stream|addon)\./;

const [source, presetKey, type, id] = process.argv.slice(2);
const preset = PRESETS[presetKey];
const cfg = Object.fromEntries([[`source_${source}`, 'on'], ['formatter_name', preset.name], ['formatter_description', preset.description]]);
const r = await fetch(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/${type || 'movie'}/${id || 'tt1375666'}.json`);
const j = await r.json();
const streams = j.body ? j.body.streams : j.streams || [];
console.log(`cards: ${streams.length}`);
let bad = 0;
for (const s of streams) {
  const vs = s.behaviorHints?.videoSize || 0;
  const ls = lines(s.title || '');
  const sizeLines = ls.filter(l => l.startsWith('📦'));
  const offender =
    (LEAK.test(s.title || '') ? 'LEAK' : null) ||
    (!ls.length ? 'empty' : null) ||
    (vs && !sizeLines.length ? 'no-size-line-despite-vs' : null) ||
    (!vs && sizeLines.length ? 'size-line-no-vs' : null) ||
    (vs && sizeLines.length && !sizeLines.includes(`📦 ${humanBytes(vs)}`) ? `size-mismatch vs=${humanBytes(vs)} got=${JSON.stringify(sizeLines)}` : null);
  if (offender) {
    bad++;
    console.log(`\n[${bad}] ${offender}`);
    console.log(`  NAME=${JSON.stringify(s.name)}`);
    console.log(`  DESC=${JSON.stringify(s.title)}`);
  }
}
console.log(`\n${bad} offenders / ${streams.length} cards`);
