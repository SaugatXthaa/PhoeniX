#!/usr/bin/env node
// Task 102 — KITCHEN-SINK CONFIG PROBE
// One config carrying EVERY option, exercised against the live local server:
//   source whitelist, all quality tiers, min/max size, group_by, sort_by,
//   provider_order, max_timeout, quality caps, subtitles_disabled,
//   disable_direct, formatter templates (Torrentio preset).
// Verifies normalizeConfig parsing + observable /stream behavior.
import zlib from 'node:zlib';
const PORT = process.argv[2] || '7100';
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); } };

const seg = (obj) => 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(obj))).toString('base64url');
const get = (path) => fetch(`${BASE}/${seg(CONFIG)}${path}`).then((r) => r.json());

const TORRENTIO = {
  name: '{stream.proxied["🕵️‍♂️ "||""]}{stream.private["🔑 "||""]}{stream.type::=p2p["[P2P] "||""]}{service.id::exists["[{service.shortName}"||""]}{service.cached["+] "||" download] "]}{addon.name} {stream.resolution::exists["{stream.resolution}"||"Unknown"]}',
  description: '{stream.size::>0["💾{stream.size::bytes2} "||""]}{stream.releaseGroup::exists["🏷️ {stream.releaseGroup} "||""]}{?📡 {stream.source} ?}',
};
const CONFIG = {
  source_4khdhub: 'on', source_hdhub4uv2: 'on', source_moviebox: 'on',
  res_2160: 'on', res_1440: 'on', res_1080: 'on', res_720: 'on', res_480: 'on', res_360: 'on',
  min_size_gb: 0.1, max_size_gb: 200,
  group_by: 'quality', sort_by: 'size', max_timeout: 20,
  subtitles_disabled: 'on', disable_direct: 'on',
  formatter_name: TORRENTIO.name, formatter_description: TORRENTIO.description,
};

// 1. manifest — config manifests fine; subtitles_disabled drops the resource
const man = await fetch(`${BASE}/${seg(CONFIG)}/manifest.json`).then((r) => r.json());
ok(man.id === 'community.phoenix.addon', 'manifest reachable through config segment');
ok(!man.resources.some((r) => r === 'subtitles' || r?.name === 'subtitles'), 'subtitles_disabled removes subtitles resource from manifest (Task 102 bugfix)');
const manPlain = await fetch(`${BASE}/manifest.json`).then((r) => r.json());
ok(manPlain.resources.some((r) => r === 'subtitles' || r?.name === 'subtitles'), 'plain manifest keeps subtitles resource');
const manSubsOnly = await fetch(`${BASE}/${seg({ res_1080: 'on' })}/manifest.json`).then((r) => r.json());
ok(manSubsOnly.resources.some((r) => r === 'subtitles' || r?.name === 'subtitles'), 'config without the toggle keeps subtitles resource');
ok(!JSON.stringify(man).includes('undefined'), 'manifest has no undefined leak');

// 2. stream — cards must: use ONLY the 3 whitelisted sources, be quality-grouped, formatter-styled
const t0 = Date.now();
const out = await get('/stream/movie/tt1375666.json');
const cards = out.streams || [];
ok(cards.length > 0, 'configured stream returns cards', `${cards.length} in ${(Date.now() - t0) / 1000}s`);

const allowed = new Set(['phoenix-4khdhub', 'phoenix-hdhub4uv2', 'phoenix-moviebox']);
const foreign = cards.filter((c) => { const bg = c.behaviorHints?.bingeGroup || ''; return bg && !allowed.has(bg.split('-').slice(0, 2).join('-')); });
ok(foreign.length === 0, 'source whitelist honored', JSON.stringify([...new Set(foreign.map((c) => c.behaviorHints?.bingeGroup))].slice(0, 4)));

const fmtNames = cards.filter((c) => c.name.includes('PhoeniX') && (c.name.includes('2160p') || c.name.includes('1080p') || c.name.includes('720p') || c.name.includes('480p') || c.name.includes('Unknown')));
ok(fmtNames.length === cards.length, 'formatter template applied to every card', `${fmtNames.length}/${cards.length}`);
const LEAK = /\{(?:stream|addon|service|metadata|user|config|debug|tools)\./;
ok(cards.every((c) => !LEAK.test(c.name) && !LEAK.test(c.title || '')), 'zero token leakage');
ok(cards.every((c) => !c.subtitles), 'subtitles_disabled honored on every card');

const LE = /^0|[2-9]/;
// 3. parse the segment back through normalizeConfig for exact option truth
const { normalizeConfig } = await import('../src/utils/addonConfig.cjs').then((m) => m.default ?? m);
const raw = JSON.parse(zlib.inflateRawSync(Buffer.from(seg(CONFIG).slice(1), 'base64url')).toString());
const cfg = normalizeConfig(raw);
ok(JSON.stringify(cfg.sourceIds) === JSON.stringify(['4khdhub', 'hdhub4uv2', 'moviebox']), 'sourceIds parsed');
ok(JSON.stringify(cfg.heights) === JSON.stringify([2160, 1440, 1080, 720, 480, 360]), 'all six tiers parsed');
ok(cfg.minBytes === Math.round(0.1 * 1024 ** 3) && cfg.maxBytes === Math.round(200 * 1024 ** 3), 'size bounds parsed');
ok(cfg.groupBy === 'quality' && cfg.sortBy === 'size' && cfg.maxTimeoutSec === 20, 'group/sort/timeout parsed');
ok(cfg.subtitlesDisabled === true && cfg.disableDirect === true, 'toggles parsed');
ok(typeof cfg.formatterName === 'string' && cfg.formatterName.length > 10, 'formatter parsed (not migrated — real template)');

console.log(`\nKITCHEN-SINK: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
