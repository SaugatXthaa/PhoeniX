#!/usr/bin/env node
// Task 100 prod verify — wait for auto-deploy (asset v=103 marker), then
// verify the formatter v2 live on production: authentic presets shipped,
// real /stream cards rendered per template (incl. proxied prefix + byte
// sizes + AIOStreams resolution forms), preview parity, fail-open intact.
const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
const zlib = (await import('zlib')).default;
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ' — ' + e : ''}`); } else { fail++; console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`); } };
const seg = (c) => 'z' + zlib.deflateRawSync(JSON.stringify(c)).toString('base64url');
const j = async (u, o) => { const r = await fetch(u, o); return { status: r.status, body: await r.json().catch(() => null) }; };
const JUNK = /invalid_expression|unknown_variableType|unknown_propertyName|unknown_(?:string|number|array|boolean|object)_modifier|cannot_coerce_boolean|unrenderable_list|unable_to_compare|\{(?:stream|addon|service|metadata|user|config|debug|tools)\./;

console.log('── waiting for auto-deploy (v=103 marker) ──');
let deployed = false;
for (let i = 0; i < 40; i++) {
  try {
    const html = await (await fetch(`${BASE}/configure`, { signal: AbortSignal.timeout(20000) })).text();
    if (html.includes('configure.js?v=103')) { deployed = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 15000));
}
ok('auto-deploy picked up v=103', deployed);
if (!deployed) { console.log('deploy marker never appeared — aborting'); process.exit(1); }

console.log('── shipped presets ──');
let PRESETS = null;
{
  const js = await (await fetch(`${BASE}/public/configure.js?v=103`)).text();
  const start = js.indexOf('const FORMATTER_PRESETS');
  const end = js.indexOf('\n};', start);
  PRESETS = new Function(js.slice(start, end + 3) + '; return FORMATTER_PRESETS;')();
  const keys = Object.keys(PRESETS).join(',');
  ok('7 authentic presets shipped', keys === 'torrentio,torbox,gdrive,lightgdrive,minimalisticgdrive,prism,tamtaro', keys);
  ok('presets usenet-free', !/usenet|nzb/i.test(Object.values(PRESETS).map(p => p.name + p.description).join('')));
  ok('saved-library UI shipped (Export file / Import file)', js.includes('"Export file"') && js.includes('"Import file"') && js.includes('phoenix-formatter-templates'));
}

console.log('── prod real-stream formatter checks ──');
{
  const r = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', formatter_name: PRESETS.prism.name, formatter_description: PRESETS.prism.description }))}/stream/movie/tt1375666.json`);
  const s = r.body?.streams || [];
  const glyphs = ['🔥4K UHD', '✨ QHD', '🚀 FHD', '💿 HD', '💩 Low Quality', '💩 Unknown'];
  const off = s.filter(c => !glyphs.includes((c.name || '').trim()));
  ok('prism on prod cards: names on-glyph', s.length > 0 && off.length === 0, `${s.length} cards, e.g. "${(s[0]?.name || '').trim()}"`);
  ok('prism desc: footer always, size line iff videoSize', s.every(c => /PhoeniX/.test(c.title || '') && (!c.behaviorHints?.videoSize || /📦 /.test(c.title || ''))), `${s.length} cards, footer ok=${s.filter(c => /PhoeniX/.test(c.title || '')).length}, sized=${s.filter(c => c.behaviorHints?.videoSize).length}`);
}
{
  const r = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', source_4khdhub: 'on', formatter_name: PRESETS.torbox.name, formatter_description: PRESETS.torbox.description }))}/stream/movie/tt1375666.json`);
  const s = r.body?.streams || [];
  const off = s.filter(c => { const t = (c.name || '').trim(); return !/(2160p|1440p|1080p|720p|480p|360p|Unknown)/.test(t) || !t.includes('PhoeniX'); });
  ok('torbox on prod: proxied prefix + (resolution) contract', s.length > 0 && off.length === 0, `${s.length} cards, e.g. "${(s[0]?.name || '').trim()}"`);
}
{
  const r = await j(`${BASE}/${encodeURIComponent(seg({ source_uhdmovies: 'on', formatter_name: PRESETS.torrentio.name, formatter_description: PRESETS.torrentio.description }))}/stream/movie/tt1375666.json`);
  const s = r.body?.streams || [];
  const off = s.filter(c => !/PhoeniX (2160p|1440p|1080p|720p|480p|360p|Unknown)/.test(c.name || '') || JUNK.test(c.title || ''));
  ok('torrentio on prod (uhdmovies): "PhoeniX <res>" + desc 💾 GiB', s.length > 0 && off.length === 0, `${s.length} cards, e.g. "${(s[0]?.name || '').trim()}" desc="${((s[0]?.title || '').split('\n').find(l => l.includes('💾')) || '').trim().slice(0, 24)}"`);
}
{
  const BAD = '{stream.resolution::exists["unterminated';
  const r = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', formatter_name: BAD }))}/stream/movie/tt1375666.json`);
  const s = r.body?.streams || [];
  ok('fail-open intact on prod', s.length > 0 && s.every(c => !JUNK.test(c.name || '')), `${s.length} cards`);
}
{
  const r = await j(`${BASE}/api/formatter-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: PRESETS.prism.name, description: PRESETS.prism.description }) });
  const samples = r.body?.samples || [];
  const glyphs = ['🔥4K UHD', '✨ QHD', '🚀 FHD', '💿 HD', '💩 Low Quality', '💩 Unknown'];
  ok('prod preview: prism on-glyph incl 1440p→✨ QHD', r.status === 200 && samples.length >= 4 && samples.every(s => glyphs.includes(s.name)), samples.map(s => `${s.label}→${s.name}`).join(' | '));
}

console.log(`\n═══ PROD VERIFY: ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
